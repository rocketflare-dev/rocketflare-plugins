/**
 * `inbox.parse`: the raw message in R2 → bodies, attachments, a confirmation code, and a call to
 * every consumer plugin. Safe to re-run (the reprocess route does exactly that): attachments are
 * unique per (message, sha256), the row is overwritten, and consumers are required to be
 * idempotent too.
 */
import {
  INBOX_EXTENSION_KEYS,
  INBOX_MESSAGES_ENTITY,
  INBOX_TEXT_BODY_MAX,
  type InboxConfirmation,
} from '@rocketflare/shared/plugins/inbox/index'
import { and, eq } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import { z } from 'zod'
import type { JobCtx } from '@/plugins/api'
import { extensions } from '@/plugins/api/peers'
import { type InboxMessageRow, inboxAttachments, inboxMessages } from '../db/schema'
import { messagePrefix } from './receive'
import {
  extractConfirmation,
  extractForwardedOriginal,
  isForwardSubject,
  keepPart,
  safeFilename,
} from './rules'

/** One stored attachment, as a consumer sees it. Read the bytes with `readInboxAttachment`. */
export interface InboxAttachmentRef {
  id: string
  filename: string
  contentType: string
  size: number
  sha256: string
  inline: boolean
}

/** What a consumer is handed for each parsed message. */
export interface InboxParsedMessage {
  tenantId: string
  messageId: string
  envelopeFrom: string
  fromAddress: string | null
  fromName: string | null
  toAddress: string
  subaddress: string | null
  subject: string | null
  sentAt: Date | null
  receivedAt: Date
  textBody: string | null
  hasHtmlBody: boolean
  attachments: readonly InboxAttachmentRef[]
}

/**
 * A plugin that wants inbound mail contributes one of these under `inbox:consumers`
 * (`extensions: inboxExtensions({ consumers: [myConsumer] })`). Called for every parsed message of
 * kind `message` (never for forwarding confirmations), after its attachments are stored. Keep it
 * quick — enqueue your own job — and idempotent: a reprocess calls it again. A throw is logged and
 * recorded on the message; it does not stop the other consumers.
 */
export interface InboxConsumer {
  id: string
  onMessage(message: InboxParsedMessage, ctx: JobCtx): Promise<void>
}

const consumerSchema = z.object({
  id: z.string().min(1),
  onMessage: z.custom<InboxConsumer['onMessage']>(v => typeof v === 'function'),
})

/** Every installed consumer, narrowed — a malformed contribution fails loudly, by plugin. */
export function inboxConsumers(): InboxConsumer[] {
  return extensions(INBOX_EXTENSION_KEYS.consumers).map(raw => {
    const parsed = consumerSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`inbox: a contributed consumer is malformed: ${parsed.error.message}`)
    }
    return parsed.data as InboxConsumer
  })
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof content === 'string') return new TextEncoder().encode(content).buffer as ArrayBuffer
  if (content instanceof Uint8Array) {
    return content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength
    ) as ArrayBuffer
  }
  return content
}

export function toParsedMessage(
  row: InboxMessageRow,
  attachments: readonly InboxAttachmentRef[]
): InboxParsedMessage {
  return {
    tenantId: row.tenantId,
    messageId: row.id,
    envelopeFrom: row.envelopeFrom,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    toAddress: row.toAddress,
    subaddress: row.subaddress,
    subject: row.subject,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    textBody: row.textBody,
    hasHtmlBody: row.htmlKey !== null,
    attachments,
  }
}

export async function parseMessage(
  ctx: JobCtx,
  tenantId: string,
  messageId: string,
  consumers: readonly InboxConsumer[] = inboxConsumers()
): Promise<void> {
  const [row] = await ctx.db
    .select()
    .from(inboxMessages)
    .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, messageId)))
    .limit(1)
  if (!row) {
    // Deleted between receive and parse: nothing to do, and retrying cannot bring it back.
    ctx.logger.warn({ tenantId, messageId }, 'inbox.parse: message no longer exists')
    return
  }

  const storage = ctx.storage()
  const object = await storage.get(row.rawKey)
  if (!object) {
    await ctx.db
      .update(inboxMessages)
      .set({ status: 'failed', error: 'The raw message is missing from storage' })
      .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, messageId)))
    return
  }
  const raw = await new Response(object.body).arrayBuffer()
  const email = await PostalMime.parse(raw)

  const prefix = messagePrefix(tenantId, messageId)
  let htmlKey: string | null = null
  if (email.html) {
    htmlKey = `${prefix}/body.html`
    await storage.put(htmlKey, email.html, { contentType: 'text/html; charset=utf-8' })
  }

  const kept: InboxAttachmentRef[] = []
  for (const [index, part] of (email.attachments ?? []).entries()) {
    const bytes = toArrayBuffer(part.content)
    const contentType = (part.mimeType || 'application/octet-stream').toLowerCase()
    const inline = part.disposition === 'inline' || Boolean(part.related)
    if (!keepPart({ inline, contentType, size: bytes.byteLength })) continue
    const sha256 = await sha256Hex(bytes)
    const filename = safeFilename(part.filename, `attachment-${index + 1}`)
    const attachmentId = crypto.randomUUID()
    const storageKey = `${prefix}/attachments/${sha256.slice(0, 16)}-${filename}`
    await storage.put(storageKey, bytes, { contentType })
    const [saved] = await ctx.db
      .insert(inboxAttachments)
      .values({
        id: attachmentId,
        tenantId,
        messageId,
        filename,
        contentType,
        size: bytes.byteLength,
        sha256,
        storageKey,
        inline,
      })
      // A reprocess finds the same bytes: keep the existing row (and its id, which a consumer
      // may already have recorded) rather than minting a second.
      .onConflictDoUpdate({
        target: [inboxAttachments.tenantId, inboxAttachments.messageId, inboxAttachments.sha256],
        set: { filename, contentType, storageKey, inline },
      })
      .returning()
    if (saved) {
      kept.push({
        id: saved.id,
        filename: saved.filename,
        contentType: saved.contentType,
        size: saved.size,
        sha256: saved.sha256,
        inline: saved.inline,
      })
    }
  }

  const text = email.text ?? null
  let confirmation = row.confirmation as InboxConfirmation | null
  if (row.kind === 'confirmation' && confirmation) {
    confirmation = extractConfirmation(confirmation.provider, row.subject, text)
  }

  // A hand-forwarded message names its real sender in the quoted header block.
  let fromAddress = email.from?.address?.toLowerCase() ?? row.fromAddress
  let fromName = email.from?.name || row.fromName
  if (row.kind === 'message' && isForwardSubject(email.subject ?? row.subject)) {
    const original = extractForwardedOriginal(text)
    if (original) {
      fromAddress = original.fromAddress
      fromName = original.fromName ?? fromName
    }
  }

  const [updated] = await ctx.db
    .update(inboxMessages)
    .set({
      status: 'parsed',
      fromAddress,
      fromName,
      subject: email.subject ?? row.subject,
      sentAt: email.date ? new Date(email.date) : row.sentAt,
      textBody: text ? text.slice(0, INBOX_TEXT_BODY_MAX) : null,
      htmlKey,
      confirmation,
      attachmentCount: kept.length,
      error: null,
      parsedAt: new Date(),
    })
    .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, messageId)))
    .returning()

  if (updated && updated.kind === 'message') {
    const failures: string[] = []
    const parsed = toParsedMessage(updated, kept)
    for (const consumer of consumers) {
      try {
        await consumer.onMessage(parsed, ctx)
      } catch (err) {
        ctx.logger.error({ err, consumer: consumer.id, messageId }, 'inbox: consumer failed')
        failures.push(`${consumer.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (failures.length > 0) {
      await ctx.db
        .update(inboxMessages)
        .set({ error: failures.join('; ').slice(0, 2000) })
        .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, messageId)))
    }
  }
  await ctx.nudge(tenantId, INBOX_MESSAGES_ENTITY, messageId)
}

/** The bytes of one attachment, for a consumer (or the download route). Null when gone. */
export async function readInboxAttachment(
  ctx: Pick<JobCtx, 'db' | 'storage'>,
  tenantId: string,
  attachmentId: string
): Promise<{ bytes: ArrayBuffer; filename: string; contentType: string } | null> {
  const [row] = await ctx.db
    .select()
    .from(inboxAttachments)
    .where(and(eq(inboxAttachments.tenantId, tenantId), eq(inboxAttachments.id, attachmentId)))
    .limit(1)
  if (!row) return null
  const object = await ctx.storage().get(row.storageKey)
  if (!object) return null
  return {
    bytes: await new Response(object.body).arrayBuffer(),
    filename: row.filename,
    contentType: row.contentType,
  }
}

/** The HTML body of one message, for a consumer that renders it (a receipt with no PDF). */
export async function readInboxHtml(
  ctx: Pick<JobCtx, 'db' | 'storage'>,
  tenantId: string,
  messageId: string
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ htmlKey: inboxMessages.htmlKey })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, messageId)))
    .limit(1)
  if (!row?.htmlKey) return null
  const object = await ctx.storage().get(row.htmlKey)
  return object ? new Response(object.body).text() : null
}
