/**
 * Forwarded-as-attachment mail. Gmail's "Forward as attachment" (and any client that forwards
 * several messages at once) sends ONE email whose `message/rfc822` parts are the real messages —
 * receipts, invoices — each a complete email of its own. Left as `.eml` attachments, no consumer
 * and no knowledge document would ever see them, so each becomes a CHILD inbox message:
 *
 * - its raw bytes under its own `tenants/<id>/inbox/<child id>/` prefix, like any message;
 * - its own From, Subject, Date and Message-ID, read from the embedded headers;
 * - the PARENT's authentication verdict. The outer forward passed the allow-list and SPF/DKIM/DMARC;
 *   the inner message's own signatures cannot be checked (a forward re-wraps it), so the trust is
 *   the forwarder's, and `forwarded_by` records whose;
 * - the normal `inbox.parse` job, so consumers and the knowledge base see one message per email.
 *
 * Idempotent without memory: `(tenant_id, parent_message_id, source_sha256)` is unique, so a
 * redelivered or reprocessed parent finds the child it already made, and an embedded Message-ID
 * the organisation has already received links to that message instead of storing it twice.
 */
import { INBOX_MESSAGES_ENTITY, INBOX_PARSE_JOB } from '@rocketflare/shared/plugins/inbox/index'
import { and, eq } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import type { JobCtx } from '@/plugins/api'
import { type InboxMessageRow, inboxMessages } from '../db/schema'
import { messagePrefix } from './receive'

/** The MIME type of an embedded message. `message/global` (SMTPUTF8) is not split. */
export const EMBEDDED_MESSAGE_TYPE = 'message/rfc822'

/** Headers are read from at most this much of an embedded message. */
const HEADER_SCAN_BYTES = 256 * 1024

export interface EmbeddedHeaders {
  fromAddress: string | null
  fromName: string | null
  subject: string | null
  messageIdHeader: string | null
  sentAt: Date | null
}

/** Where the header block of raw message bytes ends (the first empty line), or -1. */
function headerEnd(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, HEADER_SCAN_BYTES)
  for (let i = 0; i < limit - 1; i += 1) {
    if (bytes[i] !== 0x0a) continue
    if (bytes[i + 1] === 0x0a) return i + 1
    if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) return i + 2
  }
  return -1
}

/**
 * The embedded email's own headers, decoded. Only the header block is parsed — the body (and any
 * PDF in it) is the child's own `inbox.parse` to read — so splitting fifty forwards costs fifty
 * header parses, not fifty full ones.
 */
export async function readEmbeddedHeaders(bytes: ArrayBuffer): Promise<EmbeddedHeaders> {
  const view = new Uint8Array(bytes)
  const end = headerEnd(view)
  const block = end === -1 ? view.slice(0, HEADER_SCAN_BYTES) : view.slice(0, end)
  const email = await PostalMime.parse(block)
  const date = email.date ? new Date(email.date) : null
  return {
    fromAddress: email.from?.address?.toLowerCase() || null,
    fromName: email.from?.name || null,
    subject: email.subject ?? null,
    messageIdHeader: email.messageId?.trim() || null,
    sentAt: date && !Number.isNaN(date.getTime()) ? date : null,
  }
}

/** One embedded part to split out, after its `.eml` attachment row is stored. */
export interface EmbeddedPart {
  bytes: ArrayBuffer
  sha256: string
}

type Found = Pick<InboxMessageRow, 'id' | 'status' | 'parentMessageId'>

async function findChild(
  ctx: JobCtx,
  parent: InboxMessageRow,
  sha256: string
): Promise<Found | undefined> {
  const [row] = await ctx.db
    .select({
      id: inboxMessages.id,
      status: inboxMessages.status,
      parentMessageId: inboxMessages.parentMessageId,
    })
    .from(inboxMessages)
    .where(
      and(
        eq(inboxMessages.tenantId, parent.tenantId),
        eq(inboxMessages.parentMessageId, parent.id),
        eq(inboxMessages.sourceSha256, sha256)
      )
    )
    .limit(1)
  return row
}

async function findByMessageId(
  ctx: JobCtx,
  tenantId: string,
  messageIdHeader: string
): Promise<Found | undefined> {
  const [row] = await ctx.db
    .select({
      id: inboxMessages.id,
      status: inboxMessages.status,
      parentMessageId: inboxMessages.parentMessageId,
    })
    .from(inboxMessages)
    .where(
      and(eq(inboxMessages.tenantId, tenantId), eq(inboxMessages.messageIdHeader, messageIdHeader))
    )
    .limit(1)
  return row
}

export type ExpandOutcome =
  | { status: 'created'; messageId: string }
  | { status: 'existing'; messageId: string }
  | { status: 'linked'; messageId: string }
  | { status: 'skipped' }

/**
 * Split one embedded message out of `parent`. `existing` is the child this parent made on an
 * earlier run; `linked` is an earlier message with the same Message-ID (stored once, linked from
 * here); `skipped` means "keep it as a plain attachment" (it claims the parent's own Message-ID).
 */
export async function expandEmbeddedMessage(
  ctx: JobCtx,
  parent: InboxMessageRow,
  part: EmbeddedPart
): Promise<ExpandOutcome> {
  const resolveExisting = async (headers: EmbeddedHeaders): Promise<ExpandOutcome | null> => {
    const own = await findChild(ctx, parent, part.sha256)
    if (own) {
      // Ours, but never parsed: the enqueue after the insert may have failed and this run is the
      // retry. A second enqueue is harmless (parse is idempotent), a missing one strands the child.
      if (own.status === 'received') {
        await ctx.enqueue({
          type: INBOX_PARSE_JOB,
          payload: { tenantId: parent.tenantId, messageId: own.id },
        })
      }
      return { status: 'existing', messageId: own.id }
    }
    if (headers.messageIdHeader) {
      const seen = await findByMessageId(ctx, parent.tenantId, headers.messageIdHeader)
      if (seen?.id === parent.id) return { status: 'skipped' }
      if (seen) return { status: 'linked', messageId: seen.id }
    }
    return null
  }

  const headers = await readEmbeddedHeaders(part.bytes)
  const before = await resolveExisting(headers)
  if (before) return before

  const id = crypto.randomUUID()
  const rawKey = `${messagePrefix(parent.tenantId, id)}/raw.eml`
  const storage = ctx.storage()
  await storage.put(rawKey, part.bytes, { contentType: EMBEDDED_MESSAGE_TYPE })
  const inserted = await ctx.db
    .insert(inboxMessages)
    .values({
      id,
      tenantId: parent.tenantId,
      kind: 'message',
      // The envelope it actually arrived in; `forwardedBy` says who put it there.
      envelopeFrom: parent.envelopeFrom,
      fromAddress: headers.fromAddress,
      fromName: headers.fromName,
      toAddress: parent.toAddress,
      subaddress: parent.subaddress,
      subject: headers.subject,
      messageIdHeader: headers.messageIdHeader,
      sentAt: headers.sentAt,
      receivedAt: parent.receivedAt,
      rawKey,
      rawSize: part.bytes.byteLength,
      // The forward's verdict: the embedded message's own signatures cannot be verified.
      auth: parent.auth,
      parentMessageId: parent.id,
      forwardedBy: parent.forwardedBy ?? parent.envelopeFrom,
      forwardDepth: parent.forwardDepth + 1,
      sourceSha256: part.sha256,
    })
    // A concurrent run of the same parent (the part key) or an earlier copy of the same email (the
    // Message-ID key) won: the unique indexes decide, and this run links to the winner.
    .onConflictDoNothing()
    .returning({ id: inboxMessages.id })
  if (inserted.length === 0) {
    await storage.delete(rawKey)
    return (await resolveExisting(headers)) ?? { status: 'skipped' }
  }

  await ctx.enqueue({
    type: INBOX_PARSE_JOB,
    payload: { tenantId: parent.tenantId, messageId: id },
  })
  await ctx.nudge(parent.tenantId, INBOX_MESSAGES_ENTITY, id)
  return { status: 'created', messageId: id }
}
