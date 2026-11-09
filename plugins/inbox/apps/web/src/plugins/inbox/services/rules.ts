/**
 * The inbox's decisions as pure functions — who may send, what Cloudflare said about them, whether
 * a message is a forwarding confirmation, and who REALLY sent a forwarded message. No I/O, so every
 * rule is a table test (`tests/config/rules.test.ts`).
 */
import type { InboxAuth, InboxConfirmation } from '@rocketflare/shared/plugins/inbox/index'
import { addressParser } from 'postal-mime'

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

/** The `From:` mailbox the allow-list and the stored row both use: one, or null when it is not one. */
export function parseAddressHeader(
  value: string | null
): { address: string; name: string | null } | null {
  if (!value) return null
  const mailboxes = addressParser(value)
  // Several mailboxes, or a group, name no single sender to compare or attribute.
  const [only] = mailboxes
  if (mailboxes.length !== 1 || !only || 'group' in only) return null
  if (!only.address?.includes('@')) return null
  return { address: only.address.trim().toLowerCase(), name: only.name?.trim() || null }
}

/** The domain half of an address, lower-cased, or the value itself when it has no `@`. */
export function domainOf(address: string): string {
  const unquoted = address.trim().replace(/^"|"$/g, '').toLowerCase()
  const at = unquoted.lastIndexOf('@')
  return at === -1 ? unquoted : unquoted.slice(at + 1)
}

/** DMARC's relaxed alignment, without a public-suffix list: the same domain, or a parent of it. */
function domainsAlign(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

/** The verdicts in `Authentication-Results`, with the identity each one vouches for. */
export interface AuthenticationResults extends InboxAuth {
  /** The `smtp.mailfrom` domain of the SPF result. */
  spfDomain: string | null
  /** The `header.d` domain of every DKIM signature that passed. */
  dkimDomains: readonly string[]
  /** The `header.from` domain of the DMARC result. */
  dmarcDomain: string | null
}

/**
 * The verdicts of the receiving edge. Cloudflare prepends one `Authentication-Results` naming
 * itself (authserv-id `mx.cloudflare.net`); everything else in the message is the sender's text.
 */
const EDGE_AUTHSERV_ID = 'mx.cloudflare.net'

/** Split on any of `separators`, outside quoted strings and `(comments)`, dropping the comments. */
function splitAuthHeader(value: string, separators: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string
    if (ch === '\\') {
      if (depth === 0) current += `${ch}${value[i + 1] ?? ''}`
      i += 1
    } else if (quoted) {
      current += ch
      if (ch === '"') quoted = false
    } else if (depth > 0) {
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
    } else if (ch === '(') {
      depth = 1
    } else if (separators.includes(ch)) {
      parts.push(current)
      current = ''
    } else {
      current += ch
      if (ch === '"') quoted = true
    }
  }
  parts.push(current)
  return parts.map(part => part.trim())
}

/**
 * Which edge said what. `Headers.get` joins repeated headers with commas, so the joined value is
 * split first and only the first header naming the edge is read; within it, a result's method and
 * verdict are its first token, so an address the edge reflects into a property is never a verdict.
 */
export function parseAuthenticationResults(headers: readonly string[]): AuthenticationResults {
  const results: AuthenticationResults = {
    spf: null,
    dkim: null,
    dmarc: null,
    spfDomain: null,
    dkimDomains: [],
    dmarcDomain: null,
  }
  const edge = headers
    .flatMap(header => splitAuthHeader(header, ','))
    .find(header => splitAuthHeader(header, ';')[0]?.toLowerCase() === EDGE_AUTHSERV_ID)
  if (!edge) return results

  const dkimDomains: string[] = []
  for (const result of splitAuthHeader(edge, ';').slice(1)) {
    const [method, ...properties] = splitAuthHeader(result, ' \t\r\n').filter(Boolean)
    const verdict = /^(spf|dkim|dmarc)(?:\/\d+)?=([a-z]+)$/i.exec(method ?? '')
    if (!verdict?.[1] || !verdict[2]) continue
    const name = verdict[1].toLowerCase() as 'spf' | 'dkim' | 'dmarc'
    const value = verdict[2].toLowerCase()
    const property = (key: string) => {
      const found = properties.find(p => p.toLowerCase().startsWith(`${key}=`))
      return found ? domainOf(found.slice(key.length + 1)) : null
    }
    if (name === 'dkim') {
      if (value === 'pass') {
        const domain = property('header.d')
        if (domain) dkimDomains.push(domain)
      }
      if (results.dkim !== 'pass') results.dkim = value
    } else if (results[name] === null) {
      results[name] = value
      if (name === 'spf') results.spfDomain = property('smtp.mailfrom')
      else results.dmarcDomain = property('header.from')
    }
  }
  return { ...results, dkimDomains }
}

/** Did SPF, DKIM or DMARC pass for this domain (or one aligned with it)? */
export function authenticatesDomain(auth: AuthenticationResults, domain: string): boolean {
  const aligned = (candidate: string | null) =>
    candidate !== null && domainsAlign(candidate, domain)
  return (
    (auth.spf === 'pass' && aligned(auth.spfDomain)) ||
    (auth.dmarc === 'pass' && aligned(auth.dmarcDomain)) ||
    (auth.dkim === 'pass' && auth.dkimDomains.some(aligned))
  )
}

/** Senders of forwarding confirmations — accepted before an allow-list exists, so the code shows. */
const CONFIRMATION_SENDERS: Record<string, Exclude<InboxConfirmation['provider'], 'other'>> = {
  'forwarding-noreply@google.com': 'gmail',
  '@proton.me': 'proton',
  '@protonmail.com': 'proton',
  '@protonmail.ch': 'proton',
}

/** The domains a provider's confirmation must authenticate as. */
const CONFIRMATION_DOMAINS: Record<
  Exclude<InboxConfirmation['provider'], 'other'>,
  readonly string[]
> = {
  gmail: ['google.com'],
  proton: ['proton.me', 'protonmail.com', 'protonmail.ch'],
}

/** Which provider a confirmation sender belongs to, or null for everyone else. */
export function confirmationProvider(
  envelopeFrom: string
): Exclude<InboxConfirmation['provider'], 'other'> | null {
  for (const [entry, provider] of Object.entries(CONFIRMATION_SENDERS)) {
    if (senderMatches(envelopeFrom, [entry])) return provider
  }
  return null
}

export type AcceptVerdict =
  | { accept: true; confirmationProvider: InboxConfirmation['provider'] | null }
  | { accept: false; reason: 'disabled' | 'sender' | 'authentication' }

/**
 * Whether to take a message at all. A forwarding confirmation is accepted from its provider while
 * the organisation's setup window is open (that is the only way to see the code), and it has to
 * authenticate AS the provider — anyone can claim to be Google. Everything else needs an
 * allow-listed envelope sender OR `From:` header, and when the organisation requires
 * authentication the pass has to be for the identity that matched: forwarding keeps working by
 * listing the forwarding mailbox, and a From-only match is refused on an explicit DMARC failure.
 */
export function acceptMessage(input: {
  enabled: boolean
  allowedSenders: readonly string[]
  requireAuthentication: boolean
  envelopeFrom: string
  headerFrom: string | null
  auth: AuthenticationResults
  /** Whether the organisation's forwarding-confirmation setup window is open now. */
  confirmationWindowOpen: boolean
}): AcceptVerdict {
  const envelopeAllowed = senderMatches(input.envelopeFrom, input.allowedSenders)
  const fromAllowed =
    input.headerFrom !== null && senderMatches(input.headerFrom, input.allowedSenders)
  const allowed = envelopeAllowed || fromAllowed
  const provider =
    !allowed && input.confirmationWindowOpen ? confirmationProvider(input.envelopeFrom) : null
  if (provider) {
    return CONFIRMATION_DOMAINS[provider].some(domain => authenticatesDomain(input.auth, domain))
      ? { accept: true, confirmationProvider: provider }
      : { accept: false, reason: 'authentication' }
  }
  if (!input.enabled) return { accept: false, reason: 'disabled' }
  if (!allowed) return { accept: false, reason: 'sender' }
  if (input.requireAuthentication) {
    const proven = envelopeAllowed
      ? authenticatesDomain(input.auth, domainOf(input.envelopeFrom))
      : input.auth.dmarc !== 'fail' &&
        input.headerFrom !== null &&
        authenticatesDomain(input.auth, domainOf(input.headerFrom))
    if (!proven) return { accept: false, reason: 'authentication' }
  }
  return { accept: true, confirmationProvider: null }
}

/** The hosts a provider's confirmation link may point at (or a subdomain of one). */
const CONFIRMATION_HOSTS: Record<
  Exclude<InboxConfirmation['provider'], 'other'>,
  readonly string[]
> = {
  gmail: ['mail-settings.google.com', 'mail.google.com'],
  proton: ['proton.me', 'protonmail.com', 'protonmail.ch'],
}

function isProviderUrl(provider: InboxConfirmation['provider'], candidate: string): boolean {
  if (provider === 'other') return false
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '') return false
  const host = url.hostname.toLowerCase()
  return CONFIRMATION_HOSTS[provider].some(h => host === h || host.endsWith(`.${h}`))
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
  const url = urls.find(u => isProviderUrl(provider, u)) ?? null
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
  const mailbox = parseAddressHeader(from)
  if (!mailbox) return null
  const subject = /^\s*>?\s*Subject:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? null
  return { fromAddress: mailbox.address, fromName: mailbox.name, subject }
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
