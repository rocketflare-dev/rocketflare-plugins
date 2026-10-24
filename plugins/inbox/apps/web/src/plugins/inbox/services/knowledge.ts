/**
 * The inbox's half of the knowledge base (D34): after a parse, the message (headers + text body)
 * becomes one document and each PDF/Office/HTML/text attachment another, so chat can answer "what
 * did we pay AWS in March?" from mail nobody filed. Upserts by `externalId` (the message id, the
 * attachment id), so a reprocess replaces rather than duplicates; deleting a message deletes them.
 *
 * Best-effort, never fatal to the parse: knowledge is a convenience on top of the inbox, and an
 * embeddings outage must not leave a receipt unparsed or a consumer uncalled. Failures come back
 * as strings the caller records on the message. Images are not ingested — the kit converts
 * documents, not pictures — and forwarding confirmations never are.
 *
 * Visibility is the organisation's (`tenant`), matching the inbox itself: every member may read
 * the inbox, so every member may find its mail in search.
 */
import { INBOX_KNOWLEDGE_SOURCES } from '@rocketflare/shared/plugins/inbox/index'
import { and, asc, eq } from 'drizzle-orm'
import { tenantUsers } from '@/db/schema/kit'
import type { JobCtx, PluginContext } from '@/plugins/api'
import { deleteIngestedDocument, ingestDocument, ingestDocumentFile } from '@/plugins/api'
import type { InboxMessageRow, InboxSettingsRow } from '../db/schema'
import type { InboxAttachmentRef } from './parse'
import { readInboxAttachment } from './parse'

/** Error codes that mean "this attachment is not a document", not "something broke". */
const SKIP_CODES = new Set(['unsupported_media_type'])

function codeOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined
}

/**
 * Who owns an ingested FILE (the kit requires one — a stored original cascades from its user):
 * whoever last configured the inbox, else the organisation's longest-standing owner.
 */
export async function documentOwner(
  ctx: Pick<PluginContext, 'db'>,
  tenantId: string,
  settings: Pick<InboxSettingsRow, 'updatedByUserId'> | undefined
): Promise<string | null> {
  if (settings?.updatedByUserId) return settings.updatedByUserId
  const [owner] = await ctx.db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.role, 'owner')))
    .orderBy(asc(tenantUsers.joinedAt))
    .limit(1)
  return owner?.userId ?? null
}

/** The searchable text of one message: who, when, what, then the body. */
export function messageDocumentText(row: InboxMessageRow): string {
  const from = row.fromName ? `${row.fromName} <${row.fromAddress}>` : (row.fromAddress ?? '')
  return [
    `From: ${from}`,
    `Forwarded by: ${row.forwardedBy ?? row.envelopeFrom}`,
    row.sentAt ? `Date: ${row.sentAt.toISOString().slice(0, 10)}` : null,
    `Subject: ${row.subject ?? '(no subject)'}`,
    '',
    row.textBody ?? '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** Ingest one parsed message and its document attachments. Returns failures, never throws. */
export async function ingestMessage(
  ctx: JobCtx,
  row: InboxMessageRow,
  attachments: readonly InboxAttachmentRef[],
  settings: InboxSettingsRow | undefined
): Promise<string[]> {
  const failures: string[] = []
  const title = row.subject || `Email from ${row.fromAddress ?? row.envelopeFrom}`
  try {
    await ingestDocument(ctx, {
      tenantId: row.tenantId,
      userId: null,
      source: INBOX_KNOWLEDGE_SOURCES.message,
      externalId: row.id,
      title,
      text: messageDocumentText(row),
    })
  } catch (err) {
    ctx.logger.warn({ err, messageId: row.id }, 'inbox: knowledge ingest of the message failed')
    failures.push(`knowledge: ${err instanceof Error ? err.message : String(err)}`)
  }

  const files = attachments.filter(a => !a.contentType.startsWith('image/'))
  if (files.length === 0) return failures
  const owner = await documentOwner(ctx, row.tenantId, settings)
  if (!owner) return [...failures, 'knowledge: no owner to attach documents to']
  for (const attachment of files) {
    try {
      const file = await readInboxAttachment(ctx, row.tenantId, attachment.id)
      if (!file) continue
      await ingestDocumentFile(ctx, {
        tenantId: row.tenantId,
        userId: owner,
        source: INBOX_KNOWLEDGE_SOURCES.attachment,
        externalId: attachment.id,
        title: `${attachment.filename} — ${title}`,
        filename: attachment.filename,
        file: new Blob([file.bytes], { type: file.contentType }),
      })
    } catch (err) {
      if (SKIP_CODES.has(codeOf(err) ?? '')) continue
      ctx.logger.warn(
        { err, attachmentId: attachment.id },
        'inbox: knowledge ingest of an attachment failed'
      )
      failures.push(`knowledge (${attachment.filename}): ${codeOf(err) ?? 'failed'}`)
    }
  }
  return failures
}

/** Remove a message's documents. Idempotent; a missing document is not an error. */
export async function forgetMessage(
  ctx: PluginContext,
  tenantId: string,
  messageId: string,
  attachmentIds: readonly string[]
): Promise<void> {
  await deleteIngestedDocument(ctx, {
    tenantId,
    source: INBOX_KNOWLEDGE_SOURCES.message,
    externalId: messageId,
  })
  for (const id of attachmentIds) {
    await deleteIngestedDocument(ctx, {
      tenantId,
      source: INBOX_KNOWLEDGE_SOURCES.attachment,
      externalId: id,
    })
  }
}
