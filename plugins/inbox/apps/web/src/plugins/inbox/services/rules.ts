/**
 * The inbox's decisions as pure functions — who may send, what Cloudflare said about them, whether
 * a message is a forwarding confirmation, and who REALLY sent a forwarded message. No I/O, so every
 * rule is a table test (`tests/config/rules.test.ts`).
 */
import type { InboxAuth, InboxConfirmation } from '@rocketflare/shared/plugins/inbox/index'

/** `Me+Tag@Example.com` → `me@example.com`: lower-cased, subaddress dropped. */
export function normaliseAddress(address: string): string {
  const trimmed = address.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at === -1) return trimmed
  const local = trimmed.slice(0, at)
  const plus = local.indexOf('+')
  return `${plus === -1 ? local : local.slice(0, plus)}${trimmed.slice(at)}`
}

/** `a@b.com` matches `a@b.com` or `@b.com`; `+tags` are ignored on both sides. */
export function senderMatches(address: string, allowList: readonly string[]): boolean {
  const normal = normaliseAddress(address)
  const domain = normal.slice(normal.lastIndexOf('@'))
  return allowList.some(entry => {
    const e = entry.trim().toLowerCase()
    return e.startsWith('@') ? domain === e : normaliseAddress(e) === normal
  })
}

const AUTH_METHODS = ['spf', 'dkim', 'dmarc'] as const

/**
 * The verdicts in `Authentication-Results` (RFC 8601) — the FIRST result per method across every
 * such header, which is the one the receiving edge (Cloudflare) prepended. `null` where absent.
 */
export function parseAuthenticationResults(headers: readonly string[]): InboxAuth {
  const auth: InboxAuth = { spf: null, dkim: null, dmarc: null }
  for (const header of headers) {
    for (const method of AUTH_METHODS) {
      if (auth[method] !== null) continue
      const match = new RegExp(`\\b${method}=([a-z]+)`, 'i').exec(header)
      if (match?.[1]) auth[method] = match[1].toLowerCase()
    }
  }
  return auth
}

/** Any one of SPF, DKIM or DMARC passing. Forwarded mail usually passes SPF for the forwarder. */
export function isAuthenticated(auth: InboxAuth): boolean {
  return auth.spf === 'pass' || auth.dkim === 'pass' || auth.dmarc === 'pass'
}

/** Senders of forwarding confirmations — accepted before an allow-list exists, so the code shows. */
const CONFIRMATION_SENDERS: Record<string, InboxConfirmation['provider']> = {
  'forwarding-noreply@google.com': 'gmail',
  '@proton.me': 'proton',
  '@protonmail.com': 'proton',
  '@protonmail.ch': 'proton',
}

/** Which provider a confirmation sender belongs to, or null for everyone else. */
export function confirmationProvider(envelopeFrom: string): InboxConfirmation['provider'] | null {
  for (const [entry, provider] of Object.entries(CONFIRMATION_SENDERS)) {
    if (senderMatches(envelopeFrom, [entry])) return provider
  }
  return null
}

export type AcceptVerdict =
  | { accept: true; confirmationProvider: InboxConfirmation['provider'] | null }
  | { accept: false; reason: 'disabled' | 'sender' | 'authentication' }

/**
 * Whether to take a message at all. A forwarding confirmation is accepted from its provider even
 * before the allow-list names anybody (that is the only way to see the code), but it still has to
 * authenticate — anyone can claim to be Google. Everything else needs an allow-listed envelope
 * sender OR `From:` header, and authentication when the organisation requires it.
 */
export function acceptMessage(input: {
  enabled: boolean
  allowedSenders: readonly string[]
  requireAuthentication: boolean
  envelopeFrom: string
  headerFrom: string | null
  auth: InboxAuth
}): AcceptVerdict {
  const authenticated = isAuthenticated(input.auth)
  const allowed =
    senderMatches(input.envelopeFrom, input.allowedSenders) ||
    (input.headerFrom !== null && senderMatches(input.headerFrom, input.allowedSenders))
  const provider = allowed ? null : confirmationProvider(input.envelopeFrom)
  if (provider) {
    return authenticated
      ? { accept: true, confirmationProvider: provider }
      : { accept: false, reason: 'authentication' }
  }
  if (!input.enabled) return { accept: false, reason: 'disabled' }
  if (!allowed) return { accept: false, reason: 'sender' }
  if (input.requireAuthentication && !authenticated) {
    return { accept: false, reason: 'authentication' }
  }
  return { accept: true, confirmationProvider: null }
}

/**
 * The code and link in a forwarding-confirmation message. Gmail puts the code in the subject
 * (`(#123456789) Gmail Forwarding Confirmation`) and the body (`Confirmation code: 123456789`),
 * and the link on `mail-settings.google.com` / `mail.google.com/mail/vf-`; Proton sends a link.
 */
export function extractConfirmation(
  provider: InboxConfirmation['provider'],
  subject: string | null,
  text: string | null
): InboxConfirmation {
  const body = text ?? ''
  const code =
    /confirmation code:\s*(\d{6,})/i.exec(body)?.[1] ??
    /\(#(\d{6,})\)/.exec(subject ?? '')?.[1] ??
    null
  const urls = body.match(/https:\/\/[^\s<>"')]+/g) ?? []
  const pattern =
    provider === 'gmail'
      ? /mail-settings\.google\.com|mail\.google\.com\/mail\/vf-/
      : provider === 'proton'
        ? /proton\.me|protonmail\./
        : /./
  const url = urls.find(u => pattern.test(u)) ?? null
  return { provider, code, url }
}

/** Is this the subject line of a hand-forwarded message? */
export function isForwardSubject(subject: string | null): boolean {
  return /^\s*(fwd?|fw)\s*:/i.test(subject ?? '')
}

export interface ForwardedOriginal {
  fromAddress: string
  fromName: string | null
  subject: string | null
}

/**
 * The original sender of a HAND-forwarded message, read from the quoted header block mail clients
 * insert (`---------- Forwarded message ---------` / `Begin forwarded message:` / Outlook's
 * `From: … Sent: …`). Automatic forwarding keeps the original `From:` header, so this is only
 * consulted when the subject says `Fwd:`. Null when no block can be found.
 */
export function extractForwardedOriginal(text: string | null): ForwardedOriginal | null {
  if (!text) return null
  const marker =
    /-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:|-{2,}\s*Original Message\s*-{2,}/i.exec(
      text
    )
  const block = marker ? text.slice(marker.index, marker.index + 2000) : text.slice(0, 2000)
  const from = /^\s*>?\s*From:\s*(.+)$/im.exec(block)?.[1]?.trim()
  if (!from) return null
  const angle = /^(.*?)<([^>]+@[^>]+)>/.exec(from)
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(from)
  const fromAddress = (angle?.[2] ?? bare?.[1])?.trim().toLowerCase()
  if (!fromAddress) return null
  const name = angle?.[1]?.trim().replace(/^"|"$/g, '') || null
  const subject = /^\s*>?\s*Subject:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? null
  return { fromAddress, fromName: name, subject }
}

/** A filename safe for an R2 key and a `Content-Disposition` header. */
export function safeFilename(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned || fallback
}

/**
 * Inline parts worth keeping: anything that is not an image, and images large enough not to be a
 * logo or a tracking pixel. A receipt sent as an inline image is still kept; a 2 KB footer is not.
 */
export const INLINE_IMAGE_MIN_BYTES = 20_000

export function keepPart(part: { inline: boolean; contentType: string; size: number }): boolean {
  if (!part.inline) return true
  if (!part.contentType.startsWith('image/')) return true
  return part.size >= INLINE_IMAGE_MIN_BYTES
}
