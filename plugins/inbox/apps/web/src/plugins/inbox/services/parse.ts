/**
 * `inbox.parse`: the raw message in R2 → bodies, attachments, a confirmation code, and a call to
 * every consumer plugin. Safe to re-run (the reprocess route does exactly that): attachments are
 * unique per (message, sha256), the row is overwritten, and consumers are required to be
 * idempotent too.
 *
 * Every `message/rfc822` part is an attachment here (`forceRfc822Attachments`) — never merged into
 * this message's body — and is then split into a child message of its own (`./forwarded.ts`). Its
 * `.eml` row stays, pointing at the child through `expanded_message_id`, and is left out of what
 * consumers and the knowledge base are given: the child is where that email is processed.
 */
import {
  INBOX_EXTENSION_KEYS,
  INBOX_FORWARD_MAX_CHILDREN,
  INBOX_FORWARD_MAX_DEPTH,
  INBOX_MESSAGES_ENTITY,
  INBOX_TEXT_BODY_MAX,
  type InboxConfirmation,
} from '@rocketflare/shared/plugins/inbox/index'
import { and, eq } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import { z } from 'zod'
import type { JobCtx } from '@/plugins/api'
import { extensions } from '@/plugins/api/peers'
import { type InboxMessageRow, inboxAttachments, inboxMessages, inboxSettings } from '../db/schema'
import { EMBEDDED_MESSAGE_TYPE, type EmbeddedPart, expandEmbeddedMessage } from './forwarded'
import { ingestMessage } from './knowledge'
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
  /**
   * The ordinary attachments. An embedded email (`.eml`) that was split into a message of its own
   * is NOT here — it reaches consumers as that message, once.
   */
  attachments: readonly InboxAttachmentRef[]
  /**
   * Set when this message arrived as a `message/rfc822` part of another ("Forward as
   * attachment"): the wrapper's id. Its authentication verdict is the wrapper's.
   */
  parentMessageId: string | null
  /** Who forwarded it, for a message with a `parentMessageId`; null otherwise. */
  forwardedBy: string | null
  /** The messages split out of this one — each is delivered to consumers on its own. */
  forwardedMessageIds: readonly string[]
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
  attachments: readonly InboxAttachmentRef[],
  forwardedMessageIds: readonly string[] = []
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
    parentMessageId: row.parentMessageId,
    forwardedBy: row.forwardedBy,
    forwardedMessageIds,
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
  // Every embedded message is a part of its own, with or without a Content-Disposition: inlined,
  // a forwarded receipt would be merged into this body and never seen on its own.
  const email = await PostalMime.parse(raw, { forceRfc822Attachments: true })

  const prefix = messagePrefix(tenantId, messageId)
  let htmlKey: string | null = null
  if (email.html) {
    htmlKey = `${prefix}/body.html`
    await storage.put(htmlKey, email.html, { contentType: 'text/html; charset=utf-8' })
  }

  const kept: InboxAttachmentRef[] = []
  const embedded: (EmbeddedPart & { ref: InboxAttachmentRef })[] = []
  const failures: string[] = []
  // Confirmations are never split, and a message at the depth cap keeps its parts as attachments.
  const mayExpand = row.kind === 'message' && row.forwardDepth < INBOX_FORWARD_MAX_DEPTH
  let overflow = 0
  for (const [index, part] of (email.attachments ?? []).entries()) {
    const bytes = toArrayBuffer(part.content)
    const contentType = (part.mimeType || 'application/octet-stream').toLowerCase()
    const inline = part.disposition === 'inline' || Boolean(part.related)
    const isEmbedded = contentType === EMBEDDED_MESSAGE_TYPE
    if (!isEmbedded && !keepPart({ inline, contentType, size: bytes.byteLength })) continue
    const sha256 = await sha256Hex(bytes)
    const filename = safeFilename(
      part.filename,
      isEmbedded ? `forwarded-${index + 1}.eml` : `attachment-${index + 1}`
    )
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
    if (!saved) continue
    const ref: InboxAttachmentRef = {
      id: saved.id,
      filename: saved.filename,
      contentType: saved.contentType,
      size: saved.size,
      sha256: saved.sha256,
      inline: saved.inline,
    }
    if (isEmbedded && mayExpand) {
      if (embedded.length < INBOX_FORWARD_MAX_CHILDREN) {
        embedded.push({ bytes, sha256, ref })
        continue
      }
      overflow += 1
    }
    kept.push(ref)
  }

  // Split each embedded email into a message of its own, and point its `.eml` row at it.
  const forwardedMessageIds: string[] = []
  for (const part of embedded) {
    const outcome = await expandEmbeddedMessage(ctx, row, part)
    if (outcome.status === 'skipped') {
      kept.push(part.ref)
      continue
    }
    forwardedMessageIds.push(outcome.messageId)
    await ctx.db
      .update(inboxAttachments)
      .set({ expandedMessageId: outcome.messageId })
      .where(and(eq(inboxAttachments.tenantId, tenantId), eq(inboxAttachments.id, part.ref.id)))
  }
  if (overflow > 0) {
    ctx.logger.warn({ messageId, overflow }, 'inbox.parse: too many forwarded emails to split')
    failures.push(
      `${overflow} forwarded email(s) beyond the first ${INBOX_FORWARD_MAX_CHILDREN} were kept as attachments`
    )
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
      forwardedCount: forwardedMessageIds.length,
      error: null,
      parsedAt: new Date(),
    })
    .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, messageId)))
    .returning()

  if (updated && updated.kind === 'message') {
    const parsed = toParsedMessage(updated, kept, forwardedMessageIds)
    for (const consumer of consumers) {
      try {
        await consumer.onMessage(parsed, ctx)
      } catch (err) {
        ctx.logger.error({ err, consumer: consumer.id, messageId }, 'inbox: consumer failed')
        failures.push(`${consumer.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const [settings] = await ctx.db
      .select()
      .from(inboxSettings)
      .where(eq(inboxSettings.tenantId, tenantId))
      .limit(1)
    if (settings?.ingestToKnowledge ?? true) {
      failures.push(...(await ingestMessage(ctx, updated, kept, settings)))
    }
  }
  if (failures.length > 0) {
    await ctx.db
      .update(inboxMessages)
      .set({ error: failures.join('; ').slice(0, 2000) })
      .where(and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.id, messageId)))
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
