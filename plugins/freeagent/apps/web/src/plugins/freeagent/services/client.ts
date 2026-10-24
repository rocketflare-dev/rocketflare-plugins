/**
 * `FreeAgentClient` — the one typed fetch wrapper every call to FreeAgent goes through.
 *
 * What it does, so no caller has to:
 *
 * - **Headers.** `Authorization: Bearer`, JSON both ways, a `User-Agent` (FreeAgent requires
 *   one) and ALWAYS `X-Api-Version: 2026-09-01`, which opts into multiple attachments per
 *   explanation (`attachments[]`; the single `attachment` field goes on 1 Dec 2026).
 * - **Tokens.** It asks its `accessToken` source for a token per request; the source refreshes
 *   within two minutes of expiry, single-flight (`services/tokens.ts`). A 401 forces ONE refresh
 *   and one retry — a token revoked early looks exactly like that.
 * - **429.** FreeAgent allows 120 requests a minute and 3600 an hour per user. A 429 is waited out
 *   for its `Retry-After` (capped at a minute) up to three times, then becomes a
 *   `FreeAgentError('rate_limited')` carrying `retryAfterSeconds` — a sync job throws it and the
 *   queue's own backoff takes over, which is cheaper than holding a Worker open for an hour.
 * - **Pagination.** `per_page=100` (the maximum) and the `Link` header's `rel="next"`.
 * - **Scope of the token.** Every URL it fetches — a path, a resource URL a caller passed in, a
 *   `Link` it was handed — must be on the connection's API host. Anything else is refused BEFORE
 *   the request, because the bearer token would go with it.
 * - **Errors.** Anything not OK is a `FreeAgentError` with a code and FreeAgent's own message.
 */
import { FREEAGENT_API_VERSION } from '@rocketflare/shared/plugins/freeagent/index'
import type { FreeAgentDeps } from './env'
import { codeForStatus, FreeAgentError, freeagentErrorMessage } from './errors'

export const FREEAGENT_USER_AGENT = 'Rocketflare FreeAgent plugin (+https://rocketflare.dev)'
export const FREEAGENT_PER_PAGE = 100
const MAX_RATE_LIMIT_RETRIES = 3
const MAX_RETRY_AFTER_MS = 60_000
/** A runaway `Link` chain is a bug upstream, not a reason to page forever. */
const MAX_PAGES = 500

export type QueryValue = string | number | boolean | null | undefined
export type Query = Record<string, QueryValue>

/** Supplies a bearer token; `force` means the last one was refused — refresh regardless of expiry. */
export type AccessTokenSource = (opts: { force: boolean }) => Promise<string>

export interface FreeAgentClientOptions {
  baseUrl: string
  accessToken: AccessTokenSource
  deps: FreeAgentDeps
}

/** `<https://…?page=2>; rel="next", <…>; rel="last"` → `{ next, last }`. Pure. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {}
  if (!header) return links
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim())
    if (match?.[1] && match[2]) links[match[2]] = match[1]
  }
  return links
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

export class FreeAgentClient {
  readonly baseUrl: string
  readonly #origin: string
  readonly #accessToken: AccessTokenSource
  readonly #deps: FreeAgentDeps

  constructor(opts: FreeAgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.#origin = new URL(this.baseUrl).origin
    this.#accessToken = opts.accessToken
    this.#deps = opts.deps
  }

  /**
   * A path (`/v2/company`) or a full URL on this connection's host → a URL. Throws `bad_response`
   * for anything off-host: a resource URL is caller-supplied, and the token must never leave.
   */
  resolve(pathOrUrl: string, query: Query = {}): URL {
    let url: URL
    try {
      url = new URL(pathOrUrl, `${this.baseUrl}/`)
    } catch {
      throw new FreeAgentError('bad_response', `Not a FreeAgent URL: ${pathOrUrl}`)
    }
    if (url.origin !== this.#origin || !url.pathname.startsWith('/v2/')) {
      throw new FreeAgentError(
        'bad_response',
        `Refusing a URL outside this connection's FreeAgent API (${this.#origin}/v2/)`
      )
    }
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    return url
  }

  /** True when `url` is a resource on this connection's API — for validating caller input. */
  owns(url: string): boolean {
    try {
      this.resolve(url)
      return true
    } catch {
      return false
    }
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pathOrUrl: string,
    opts: { query?: Query; body?: unknown } = {}
  ): Promise<{ data: T; response: Response }> {
    const url = this.resolve(pathOrUrl, opts.query)
    let forced = false
    let rateLimited = 0
    for (;;) {
      const token = await this.#accessToken({ force: forced })
      const headers = new Headers({
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': FREEAGENT_USER_AGENT,
        'X-Api-Version': FREEAGENT_API_VERSION,
      })
      if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
      let response: Response
      try {
        response = await this.#deps.fetch(url.toString(), {
          method,
          headers,
          ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        })
      } catch (err) {
        throw new FreeAgentError(
          'network',
          `FreeAgent did not answer: ${err instanceof Error ? err.message : String(err)}`
        )
      }

      if (response.status === 401 && !forced) {
        forced = true
        continue
      }
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('Retry-After')) ?? 1000
        if (rateLimited < MAX_RATE_LIMIT_RETRIES && wait <= MAX_RETRY_AFTER_MS) {
          rateLimited++
          await this.#deps.sleep(wait)
          continue
        }
        throw new FreeAgentError('rate_limited', 'FreeAgent rate limit reached; try again later', {
          status: 429,
          retryAfterSeconds: Math.ceil(wait / 1000),
        })
      }

      const text = await response.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          if (response.ok) {
            throw new FreeAgentError('bad_response', 'FreeAgent answered with something not JSON', {
              status: response.status,
            })
          }
        }
      }
      if (!response.ok) {
        const message =
          freeagentErrorMessage(body) ?? `FreeAgent answered ${response.status} for ${method}`
        throw new FreeAgentError(codeForStatus(response.status), message, {
          status: response.status,
        })
      }
      return { data: body as T, response }
    }
  }

  async get<T = unknown>(pathOrUrl: string, query?: Query): Promise<T> {
    return (await this.request<T>('GET', pathOrUrl, { query })).data
  }

  async post<T = unknown>(pathOrUrl: string, body: unknown): Promise<T> {
    return (await this.request<T>('POST', pathOrUrl, { body })).data
  }

  async put<T = unknown>(pathOrUrl: string, body: unknown): Promise<T> {
    return (await this.request<T>('PUT', pathOrUrl, { body })).data
  }

  async delete(pathOrUrl: string): Promise<void> {
    await this.request('DELETE', pathOrUrl)
  }

  /**
   * Every page of a list endpoint, one array per page. `key` is the list's root element
   * (`bank_transactions`). Follows `Link: rel="next"` — through `resolve`, so a next link pointing
   * anywhere else stops the walk with an error rather than leaking the token.
   */
  async *pages<T = unknown>(path: string, key: string, query: Query = {}): AsyncGenerator<T[]> {
    let next: string | null = this.resolve(path, {
      per_page: FREEAGENT_PER_PAGE,
      ...query,
    }).toString()
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const { data, response }: { data: unknown; response: Response } = await this.request(
        'GET',
        next
      )
      const items = (data as Record<string, unknown> | null)?.[key]
      if (!Array.isArray(items)) {
        throw new FreeAgentError('bad_response', `FreeAgent's ${path} answer has no "${key}" list`)
      }
      yield items as T[]
      next = parseLinkHeader(response.headers.get('Link')).next ?? null
    }
  }

  /** Every item of a list endpoint, all pages. For small lists; the sync walks `pages`. */
  async all<T = unknown>(path: string, key: string, query: Query = {}): Promise<T[]> {
    const out: T[] = []
    for await (const page of this.pages<T>(path, key, query)) out.push(...page)
    return out
  }
}
