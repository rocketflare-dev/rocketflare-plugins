/**
 * `/api/inbox` — settings, the message list, one message, its raw `.eml`, its HTML body, an
 * attachment's bytes, reprocess and delete.
 *
 * Downloads are always `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`:
 * these are bytes a stranger chose, and rendering them on this origin would hand that stranger a
 * page with the user's cookies. The HTML body in particular is served as an attachment, never
 * inline.
 */
import {
  INBOX_MESSAGE_SUBJECT,
  INBOX_MESSAGES_ENTITY,
  INBOX_PARSE_JOB,
  INBOX_SETTINGS_ENTITY,
  INBOX_SETTINGS_SUBJECT,
  type InboxAttachment,
  type InboxAuth,
  type InboxConfirmation,
  type InboxMessage,
  type InboxMessageListQuery,
  type InboxMessageSummary,
  inboxMessageListQuerySchema,
  type UpdateInboxSettings,
  updateInboxSettingsSchema,
} from '@rocketflare/shared/plugins/inbox/index'
import { and, count, desc, eq, type SQL } from 'drizzle-orm'
import type { RequestCtx } from '@/plugins/api'
import {
  createRouter,
  isUniqueViolation,
  recordActivity,
  requestCtx,
  validate,
} from '@/plugins/api'
import { type InboxMessageRow, inboxAttachments, inboxMessages } from '../db/schema'
import { forgetMessage } from '../services/knowledge'
import { messagePrefix } from '../services/receive'
import { loadSettings, saveSettings, toSettings } from './settings'

export const inboxRouter = createRouter()

function toSummary(row: InboxMessageRow): InboxMessageSummary {
  return {
    id: row.id,
    status: row.status as InboxMessageSummary['status'],
    kind: row.kind as InboxMessageSummary['kind'],
    envelopeFrom: row.envelopeFrom,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    toAddress: row.toAddress,
    subaddress: row.subaddress,
    subject: row.subject,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    attachmentCount: row.attachmentCount,
    rawSize: row.rawSize,
  }
}

function download(body: ReadableStream, contentType: string, filename: string, size?: number) {
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  })
  if (size !== undefined) headers.set('Content-Length', String(size))
  return new Response(body, { headers })
}

async function loadMessage(ctx: RequestCtx, id: string): Promise<InboxMessageRow> {
  const [row] = await ctx.db
    .select()
    .from(inboxMessages)
    .where(and(eq(inboxMessages.tenantId, ctx.tenantId), eq(inboxMessages.id, id)))
    .limit(1)
  return row ?? ctx.notFound('Message not found', 'inbox_message_not_found')
}

// ---- settings -----------------------------------------------------------------------------------

inboxRouter.get('/settings', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', INBOX_SETTINGS_SUBJECT)
  return c.json(toSettings(await loadSettings(ctx.db, ctx.tenantId)))
})

inboxRouter.put('/settings', validate('json', updateInboxSettingsSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', INBOX_SETTINGS_SUBJECT)
  const body = ctx.valid<UpdateInboxSettings>('json')
  const existing = await loadSettings(ctx.db, ctx.tenantId)
  const localPart = body.localPart ?? existing?.localPart ?? null
  if ((body.enabled ?? existing?.enabled) && !localPart) {
    ctx.badRequest('Choose an address before turning the inbox on', 'inbox_local_part_required')
  }
  let row: Awaited<ReturnType<typeof saveSettings>>
  try {
    row = await saveSettings(ctx.db, ctx.tenantId, ctx.userId, body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      ctx.conflict('That address is already taken', 'inbox_local_part_taken')
    }
    throw err
  }
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'inbox.settings.updated',
      subjectType: INBOX_SETTINGS_SUBJECT,
      subjectId: row.id,
      metadata: {
        enabled: row.enabled,
        localPart: row.localPart,
        allowedSenders: row.allowedSenders.length,
      },
    })
  )
  ctx.nudge(INBOX_SETTINGS_ENTITY)
  return c.json(toSettings(row))
})

// ---- messages -----------------------------------------------------------------------------------

inboxRouter.get('/messages', validate('query', inboxMessageListQuerySchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', INBOX_MESSAGE_SUBJECT)
  const query = ctx.valid<InboxMessageListQuery>('query')
  const filters: SQL[] = [eq(inboxMessages.tenantId, ctx.tenantId)]
  if (query.status) filters.push(eq(inboxMessages.status, query.status))
  if (query.kind) filters.push(eq(inboxMessages.kind, query.kind))
  const where = and(...filters)
  const [rows, totals] = await Promise.all([
    ctx.db
      .select()
      .from(inboxMessages)
      .where(where)
      .orderBy(desc(inboxMessages.receivedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    ctx.db.select({ total: count() }).from(inboxMessages).where(where),
  ])
  return c.json(ctx.page(rows.map(toSummary), totals[0]?.total ?? 0, query))
})

inboxRouter.get('/messages/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', INBOX_MESSAGE_SUBJECT)
  const row = await loadMessage(ctx, ctx.uuid('id'))
  const attachments = await ctx.db
    .select()
    .from(inboxAttachments)
    .where(and(eq(inboxAttachments.tenantId, ctx.tenantId), eq(inboxAttachments.messageId, row.id)))
    .orderBy(inboxAttachments.createdAt)
  const body: InboxMessage = {
    ...toSummary(row),
    messageIdHeader: row.messageIdHeader,
    auth: { spf: null, dkim: null, dmarc: null, ...(row.auth as Partial<InboxAuth>) },
    textBody: row.textBody,
    hasHtmlBody: row.htmlKey !== null,
    confirmation: (row.confirmation as InboxConfirmation | null) ?? null,
    error: row.error,
    attachments: attachments.map(
      (a): InboxAttachment => ({
        id: a.id,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        sha256: a.sha256,
        inline: a.inline,
      })
    ),
  }
  return c.json(body)
})

inboxRouter.get('/messages/:id/raw', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', INBOX_MESSAGE_SUBJECT)
  const row = await loadMessage(ctx, ctx.uuid('id'))
  const object = await ctx.storage().get(row.rawKey)
  if (!object) ctx.notFound('The raw message is missing', 'inbox_raw_missing')
  return download(object.body, 'message/rfc822', `${row.id}.eml`, object.size)
})

inboxRouter.get('/messages/:id/html', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', INBOX_MESSAGE_SUBJECT)
  const row = await loadMessage(ctx, ctx.uuid('id'))
  if (!row.htmlKey) ctx.notFound('This message has no HTML body', 'inbox_html_missing')
  const object = await ctx.storage().get(row.htmlKey)
  if (!object) ctx.notFound('The HTML body is missing', 'inbox_html_missing')
  return download(object.body, 'text/html; charset=utf-8', `${row.id}.html`, object.size)
})

inboxRouter.get('/attachments/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', INBOX_MESSAGE_SUBJECT)
  const id = ctx.uuid('id')
  const [row] = await ctx.db
    .select()
    .from(inboxAttachments)
    .where(and(eq(inboxAttachments.tenantId, ctx.tenantId), eq(inboxAttachments.id, id)))
    .limit(1)
  if (!row) ctx.notFound('Attachment not found', 'inbox_attachment_not_found')
  const object = await ctx.storage().get(row.storageKey)
  if (!object) ctx.notFound('The attachment is missing', 'inbox_attachment_missing')
  return download(object.body, row.contentType, row.filename, object.size)
})

inboxRouter.post('/messages/:id/reprocess', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('update', INBOX_MESSAGE_SUBJECT)
  const row = await loadMessage(ctx, ctx.uuid('id'))
  const job = await ctx.enqueue({
    type: INBOX_PARSE_JOB,
    payload: { tenantId: ctx.tenantId, messageId: row.id },
  })
  return c.json({ jobId: job.id, type: INBOX_PARSE_JOB }, 202)
})

inboxRouter.delete('/messages/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('delete', INBOX_MESSAGE_SUBJECT)
  const row = await loadMessage(ctx, ctx.uuid('id'))
  const attachmentIds = await ctx.db
    .select({ id: inboxAttachments.id })
    .from(inboxAttachments)
    .where(and(eq(inboxAttachments.tenantId, ctx.tenantId), eq(inboxAttachments.messageId, row.id)))
  // Knowledge first: its documents are found by these ids, which the cascade is about to remove.
  await forgetMessage(
    ctx,
    ctx.tenantId,
    row.id,
    attachmentIds.map(a => a.id)
  )
  await ctx.db
    .delete(inboxMessages)
    .where(and(eq(inboxMessages.tenantId, ctx.tenantId), eq(inboxMessages.id, row.id)))
  // The row is the truth; the objects follow. A failure here leaves orphans under the tenant's
  // prefix, which the tenant purge still removes.
  const storage = ctx.storage()
  const objects = await storage.list(`${messagePrefix(ctx.tenantId, row.id)}/`)
  if (objects.length > 0) await storage.deleteMany(objects.map(o => o.key))
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'inbox.message.deleted',
      subjectType: INBOX_MESSAGE_SUBJECT,
      subjectId: row.id,
      metadata: { fromAddress: row.fromAddress },
    })
  )
  ctx.nudge(INBOX_MESSAGES_ENTITY, row.id)
  return c.body(null, 204)
})
