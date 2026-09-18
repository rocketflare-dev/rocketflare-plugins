/**
 * The provider seam: one adapter per search API, each normalising to the same `SearchHit`.
 *
 * Every adapter takes its `fetch` from the call rather than the global, so a test hands in a fake
 * and no test reaches a provider. Every failure is a `WebSearchError` with a code the tool turns
 * into a hint the model can act on — "the key was rejected" means "tell the user", "rate limited"
 * means "stop searching", and neither is worth a retry loop.
 */

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /** ISO date or the provider's own relative age ("2 days ago"), when it gives one. */
  publishedAt?: string
}

export interface ExtractedPage {
  url: string
  title?: string
  /** Markdown or plain text. */
  content: string
}

export type WebSearchErrorCode = 'key_rejected' | 'rate_limited' | 'timeout' | 'provider_error'

export class WebSearchError extends Error {
  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'WebSearchError'
  }
}

export interface ProviderCall {
  apiKey: string
  fetch: typeof fetch
  /** Milliseconds before the call is abandoned. */
  timeoutMs?: number
}

export interface SearchAdapter {
  search(call: ProviderCall, query: string, maxResults: number): Promise<SearchHit[]>
  /** Present only where the provider can fetch a page for us (`WebSearchProviderInfo.extracts`). */
  extract?(call: ProviderCall, url: string): Promise<ExtractedPage>
}

const DEFAULT_TIMEOUT_MS = 15_000
const SNIPPET_MAX_CHARS = 1_000

/**
 * One provider request: timeout, status → code, JSON body. `name` goes into the messages because
 * the model relays them to a person who needs to know WHICH service said no.
 */
export async function providerJson(
  call: ProviderCall,
  name: string,
  url: string,
  init: RequestInit
): Promise<unknown> {
  let res: Response
  try {
    res = await call.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new WebSearchError('timeout', `${name} did not answer in time`)
    }
    throw new WebSearchError('provider_error', `${name} could not be reached`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new WebSearchError('key_rejected', `${name} rejected the API key`, res.status)
  }
  if (res.status === 429 || res.status === 432) {
    throw new WebSearchError('rate_limited', `${name} rate limit or quota reached`, res.status)
  }
  if (!res.ok) {
    throw new WebSearchError('provider_error', `${name} answered HTTP ${res.status}`, res.status)
  }
  try {
    return await res.json()
  } catch {
    throw new WebSearchError('provider_error', `${name} answered something that is not JSON`)
  }
}

/** Keep a hit only when it has a URL; trim the snippet to what a model can use. */
export function hit(input: {
  title?: unknown
  url?: unknown
  snippet?: unknown
  publishedAt?: unknown
}): SearchHit | null {
  if (typeof input.url !== 'string' || input.url.length === 0) return null
  const snippet = typeof input.snippet === 'string' ? input.snippet.trim() : ''
  return {
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : input.url,
    url: input.url,
    snippet:
      snippet.length > SNIPPET_MAX_CHARS ? `${snippet.slice(0, SNIPPET_MAX_CHARS)}…` : snippet,
    ...(typeof input.publishedAt === 'string' &&
      input.publishedAt && { publishedAt: input.publishedAt }),
  }
}

export function hits(items: unknown, map: (item: Record<string, unknown>) => SearchHit | null) {
  if (!Array.isArray(items)) return []
  return items
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(map)
    .filter((h): h is SearchHit => h !== null)
}

/** Read `obj.a.b.c` from an unknown JSON body without a cascade of casts. */
export function path(obj: unknown, ...keys: string[]): unknown {
  let cur = obj
  for (const key of keys) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
