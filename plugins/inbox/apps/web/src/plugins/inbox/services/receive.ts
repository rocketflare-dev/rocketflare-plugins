/**
 * The `email()` half: decide, store, queue — and nothing slower. Parsing a 20 MB PDF-laden message
 * inside the Email Worker would spend its CPU budget on a sender who is waiting for an SMTP answer,
 * so the raw bytes go to R2 and `inbox.parse` does the rest.
 *
 * Order matters for what a failure means. Everything that can REFUSE (unknown address, sender,
 * authentication) runs before any write and answers `setReject` — a permanent bounce the forwarding
 * mailbox will show its owner. Everything after that is storage, and a throw there is rethrown by
 * the kit as a temporary failure, so the sender retries rather than the message being lost.
 */
import {
  INBOX_MESSAGES_ENTITY,
  INBOX_PARSE_JOB,
  type InboxConfirmation,
} from '@rocketflare/shared/plugins/inbox/index'
import { and, eq } from 'drizzle-orm'
import type { Database, EmailCtx } from '@/plugins/api'
import { emailLocalPart, emailSubaddress } from '@/plugins/api'
import { type InboxSettingsRow, inboxMessages, inboxSettings } from '../db/schema'
import { acceptMessage, parseAuthenticationResults } from './rules'

/** The R2 prefix for one message: raw bytes, HTML body and attachments all live beneath it. */
export function messagePrefix(tenantId: string, messageId: string): string {
  return `tenants/${tenantId}/inbox/${messageId}`
}

/**
 * The organisation that receives on this local part. The plugin's one cross-tenant read: a message
 * names an address, not a tenant, and the unique index on `local_part` makes the answer one row.
 */
export async function settingsForLocalPart(
  db: Database,
  localPart: string
): Promise<InboxSettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(inboxSettings)
    .where(eq(inboxSettings.localPart, localPart))
    .limit(1)
  return row
}

/** `"Name" <a@b.com>` → `{ address, name }`; null when no address can be read. */
export function parseAddressHeader(
  value: string | null
): { address: string; name: string | null } | null {
  if (!value) return null
  const angle = /^(.*?)<([^>]+@[^>]+)>/.exec(value)
  if (angle?.[2]) {
    const name = angle[1]?.trim().replace(/^"|"$/g, '') || null
    return { address: angle[2].trim().toLowerCase(), name }
  }
  const bare = /([^\s<>",]+@[^\s<>",]+)/.exec(value)
  return bare?.[1] ? { address: bare[1].toLowerCase(), name: null } : null
}

/** `Date:` → a Date, or null when absent or unparseable. */
function headerDate(value: string | null): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Why a message was refused, in the words the forwarding mailbox will show its owner. */
const REJECT_REASONS = {
  address: 'Unknown recipient',
  disabled: 'This inbox is not accepting mail',
  sender: 'Sender not allowed',
  authentication: 'Sender could not be authenticated',
} as const

export type ReceiveOutcome =
  | { status: 'rejected'; reason: keyof typeof REJECT_REASONS }
  | { status: 'duplicate'; messageId: string }
  | { status: 'stored'; messageId: string; tenantId: string }

/**
 * Take one message. Exported so tests drive it with a fake `ForwardableEmailMessage`; the
 * registered handler in `index.ts` is a one-line adapter.
 */
export async function receiveMessage(
  message: ForwardableEmailMessage,
  ctx: EmailCtx,
  options: { authenticationOptional?: boolean } = {}
): Promise<ReceiveOutcome> {
  const reject = (reason: keyof typeof REJECT_REASONS): ReceiveOutcome => {
    // Addresses and the reason only — never a subject or body in a log line.
    ctx.logger.warn({ to: message.to, from: message.from, reason }, 'inbox: message refused')
    message.setReject(REJECT_REASONS[reason])
    return { status: 'rejected', reason }
  }

  const settings = await settingsForLocalPart(ctx.db, emailLocalPart(message.to))
  if (!settings) return reject('address')

  const headerFrom = parseAddressHeader(message.headers.get('from'))
  const auth = parseAuthenticationResults(
    [message.headers.get('authentication-results')].filter((h): h is string => Boolean(h))
  )
  const verdict = acceptMessage({
    enabled: settings.enabled,
    allowedSenders: settings.allowedSenders,
    // Local `wrangler dev` deliveries carry no Authentication-Results at all.
    requireAuthentication: settings.requireAuthentication && !options.authenticationOptional,
    envelopeFrom: message.from,
    headerFrom: headerFrom?.address ?? null,
    auth,
  })
  if (!verdict.accept) return reject(verdict.reason)

  const tenantId = settings.tenantId
  const messageIdHeader = message.headers.get('message-id')?.trim() || null
  if (messageIdHeader) {
    const [existing] = await ctx.db
      .select({ id: inboxMessages.id })
      .from(inboxMessages)
      .where(
        and(
          eq(inboxMessages.tenantId, tenantId),
          eq(inboxMessages.messageIdHeader, messageIdHeader)
        )
      )
      .limit(1)
    if (existing) {
      ctx.logger.info({ messageId: existing.id }, 'inbox: duplicate delivery ignored')
      return { status: 'duplicate', messageId: existing.id }
    }
  }

  const id = crypto.randomUUID()
  const rawKey = `${messagePrefix(tenantId, id)}/raw.eml`
  const raw = await new Response(message.raw).arrayBuffer()
  await ctx.storage().put(rawKey, raw, { contentType: 'message/rfc822' })

  const confirmation: InboxConfirmation | null = verdict.confirmationProvider
    ? { provider: verdict.confirmationProvider, code: null, url: null }
    : null
  const inserted = await ctx.db
    .insert(inboxMessages)
    .values({
      id,
      tenantId,
      kind: confirmation ? 'confirmation' : 'message',
      envelopeFrom: message.from.toLowerCase(),
      fromAddress: headerFrom?.address ?? null,
      fromName: headerFrom?.name ?? null,
      toAddress: message.to.toLowerCase(),
      subaddress: emailSubaddress(message.to),
      subject: message.headers.get('subject'),
      messageIdHeader,
      sentAt: headerDate(message.headers.get('date')),
      rawKey,
      rawSize: raw.byteLength,
      auth,
      confirmation,
    })
    // Two deliveries racing past the lookup above: the unique index decides, the loser is a no-op.
    .onConflictDoNothing()
    .returning({ id: inboxMessages.id })
  if (inserted.length === 0) {
    await ctx.storage().delete(rawKey)
    return { status: 'duplicate', messageId: id }
  }

  await ctx.enqueue({ type: INBOX_PARSE_JOB, payload: { tenantId, messageId: id } })
  await ctx.nudge(tenantId, INBOX_MESSAGES_ENTITY, id)
  return { status: 'stored', messageId: id, tenantId }
}
