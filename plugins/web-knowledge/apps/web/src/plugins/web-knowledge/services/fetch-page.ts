/**
 * `fetch_page` without a provider: the Worker fetches the URL itself and turns it into text.
 *
 * **The model chooses the URL, so the URL is untrusted input.** On Cloudflare's network a Worker
 * cannot reach private address space, but under `wrangler dev` it runs on somebody's laptop, where
 * `http://localhost:5432` and the router's admin page are one tool call away. So the guard refuses
 * anything that is not a public-looking hostname on the default ports, and it runs again on every
 * redirect hop (`redirect: 'manual'`), because "a public page that redirects to localhost" is the
 * standard way round a guard that only checks the first URL. What it cannot see is a public name
 * that RESOLVES to a private address — there is no DNS API in a Worker — which is the residual risk
 * the plugin's CLAUDE.md records.
 */
import type { ExtractedPage } from './providers'
import { WebSearchError } from './providers'

const MAX_REDIRECTS = 5
const MAX_BYTES = 2_000_000
const TIMEOUT_MS = 15_000
const USER_AGENT = 'Mozilla/5.0 (compatible; RocketflareWebKnowledge/1.0)'

/** Hostname suffixes that name a private network by convention. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet']

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string }

export function guardUrl(raw: string | URL): UrlVerdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https URLs can be fetched' }
  }
  if (url.username || url.password)
    return { ok: false, reason: 'URLs with credentials are refused' }
  if (url.port && url.port !== '80' && url.port !== '443') {
    return { ok: false, reason: 'only the default ports can be fetched' }
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // `[::1]`, and every IPv4 spelling WHATWG accepts (`127.1`, `0x7f.0.0.1`, `2130706433`) ends up
  // as a dotted quad in `hostname`, so one numeric test covers them all.
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) {
    return { ok: false, reason: 'IP addresses are refused; use a hostname' }
  }
  if (host === 'localhost' || !host.includes('.') || PRIVATE_SUFFIXES.some(s => host.endsWith(s))) {
    return { ok: false, reason: 'private and local hostnames are refused' }
  }
  return { ok: true, url }
}

/** The slice of the Workers AI binding this needs; `ctx.env.AI` is typed per deployment. */
export interface MarkdownConverter {
  toMarkdown(document: {
    name: string
    blob: Blob
  }): Promise<{ format: string; data?: string; error?: string }>
}

export function converterOf(env: unknown): MarkdownConverter | null {
  const ai = (env as { AI?: Partial<MarkdownConverter> } | undefined)?.AI
  return ai && typeof ai.toMarkdown === 'function' ? (ai as MarkdownConverter) : null
}

async function readCapped(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(total, MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.byteLength - offset)
    out.set(chunk.subarray(0, take), offset)
    offset += take
    if (offset >= out.byteLength) break
  }
  return out
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** A last-resort HTML → text for a Worker without `[ai]`: drop non-content, keep block breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] === '#') {
        const code =
          name[1]?.toLowerCase() === 'x'
            ? Number.parseInt(name.slice(2), 16)
            : Number(name.slice(1))
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : match
      }
      return ENTITIES[name.toLowerCase()] ?? match
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function titleOf(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = match?.[1] ? htmlToText(match[1]) : ''
  return title || undefined
}

export interface FetchPageDeps {
  fetch: typeof fetch
  converter: MarkdownConverter | null
}

/** Fetch one public page and answer its text. Every refusal is a `WebSearchError`. */
export async function fetchPageDirect(raw: string, deps: FetchPageDeps): Promise<ExtractedPage> {
  let target = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = guardUrl(target)
    if (!verdict.ok)
      throw new WebSearchError('provider_error', `Refused ${target}: ${verdict.reason}`)
    let res: Response
    try {
      res = await deps.fetch(verdict.url.toString(), {
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new WebSearchError(
        timedOut ? 'timeout' : 'provider_error',
        timedOut ? 'The page did not answer in time' : 'The page could not be reached'
      )
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, verdict.url).toString()
      continue
    }
    if (!res.ok) {
      throw new WebSearchError('provider_error', `The page answered HTTP ${res.status}`, res.status)
    }
    return toPage(verdict.url.toString(), res, deps.converter)
  }
  throw new WebSearchError('provider_error', `More than ${MAX_REDIRECTS} redirects`)
}

async function toPage(
  url: string,
  res: Response,
  converter: MarkdownConverter | null
): Promise<ExtractedPage> {
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const bytes = await readCapped(res)
  const isHtml = type === 'text/html' || type === 'application/xhtml+xml' || type === ''
  const isPdf = type === 'application/pdf'
  if (isHtml || isPdf) {
    const html = isHtml ? new TextDecoder().decode(bytes) : ''
    const title = isHtml ? titleOf(html) : undefined
    if (converter) {
      const converted = await converter
        .toMarkdown({
          name: isPdf ? 'page.pdf' : 'page.html',
          blob: new Blob([bytes], { type: type || 'text/html' }),
        })
        .catch(() => null)
      if (converted && converted.format !== 'error' && typeof converted.data === 'string') {
        return { url, content: converted.data, ...(title && { title }) }
      }
    }
    if (isPdf) {
      throw new WebSearchError(
        'provider_error',
        'This Worker cannot convert PDFs (no Workers AI binding)'
      )
    }
    return { url, content: htmlToText(html), ...(title && { title }) }
  }
  if (type.startsWith('text/') || type === 'application/json' || type.endsWith('+json')) {
    return { url, content: new TextDecoder().decode(bytes) }
  }
  throw new WebSearchError('provider_error', `Pages of type ${type} cannot be read`)
}
