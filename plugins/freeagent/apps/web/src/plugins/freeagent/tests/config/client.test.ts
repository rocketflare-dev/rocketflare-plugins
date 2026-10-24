/**
 * `FreeAgentClient` with an injected fetch: headers, 429 back-off (bounded), 401 → one forced
 * refresh, `Link` pagination, the off-host refusal and the error mapping. No database, no network.
 */
import { describe, expect, it, vi } from 'vitest'
import { FreeAgentClient, parseLinkHeader, retryAfterMs } from '../../services/client'
import type { FetchLike } from '../../services/env'
import { FreeAgentError } from '../../services/errors'

const BASE = 'https://api.sandbox.freeagent.com'

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  })
}

function client(fetch: FetchLike, token = vi.fn(async (_opts: { force: boolean }) => 'tok')) {
  const sleep = vi.fn(async (_ms: number) => {})
  return {
    c: new FreeAgentClient({ baseUrl: BASE, accessToken: token, deps: { fetch, sleep } }),
    sleep,
    token,
  }
}

describe('pure helpers', () => {
  it('parses Link headers and Retry-After', () => {
    expect(
      parseLinkHeader(
        `<${BASE}/v2/contacts?page=2&per_page=100>; rel="next", <${BASE}/v2/contacts?page=5>; rel="last"`
      )
    ).toEqual({
      next: `${BASE}/v2/contacts?page=2&per_page=100`,
      last: `${BASE}/v2/contacts?page=5`,
    })
    expect(parseLinkHeader(null)).toEqual({})
    expect(retryAfterMs('60')).toBe(60_000)
    expect(retryAfterMs(new Date(1_000_000 + 5_000).toUTCString(), 1_000_000)).toBeLessThanOrEqual(
      5_000
    )
    expect(retryAfterMs('soon')).toBeNull()
  })
})

describe('requests', () => {
  it('always sends the API version, a bearer token and a user agent', async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ company: { name: 'x' } }))
    const { c } = client(fetch)
    await c.get('/v2/company')
    const [url, init] = fetch.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(url).toBe(`${BASE}/v2/company`)
    expect(headers.get('X-Api-Version')).toBe('2026-09-01')
    expect(headers.get('Authorization')).toBe('Bearer tok')
    expect(headers.get('User-Agent')).toBeTruthy()
  })

  it('waits out a 429 for its Retry-After, then succeeds', async () => {
    let calls = 0
    const fetch: FetchLike = async () =>
      ++calls < 3 ? json({}, { status: 429, headers: { 'Retry-After': '2' } }) : json({ ok: true })
    const { c, sleep } = client(fetch)
    expect(await c.get('/v2/company')).toEqual({ ok: true })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 2000])
  })

  it('gives up after three waits, or at once when Retry-After is too long', async () => {
    const always: FetchLike = async () => json({}, { status: 429, headers: { 'Retry-After': '1' } })
    const { c, sleep } = client(always)
    await expect(c.get('/v2/company')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 1,
    })
    expect(sleep).toHaveBeenCalledTimes(3)

    const hour: FetchLike = async () =>
      json({}, { status: 429, headers: { 'Retry-After': '3600' } })
    const second = client(hour)
    await expect(second.c.get('/v2/company')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 3600,
    })
    expect(second.sleep).not.toHaveBeenCalled()
  })

  it('forces one token refresh on a 401, and no more', async () => {
    const statuses = [401, 200]
    const fetch: FetchLike = async () => json({ ok: true }, { status: statuses.shift() ?? 401 })
    const { c, token } = client(fetch)
    await c.get('/v2/company')
    expect(token.mock.calls.map(([o]) => o.force)).toEqual([false, true])

    const never: FetchLike = async () =>
      json({ errors: { error: { message: 'Access denied' } } }, { status: 401 })
    await expect(client(never).c.get('/v2/company')).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Access denied',
    })
  })

  it('maps FreeAgent errors to codes with FreeAgent’s message', async () => {
    const fetch: FetchLike = async () =>
      json({ errors: [{ message: 'Gross value is not a number' }] }, { status: 422 })
    await expect(client(fetch).c.post('/v2/bills', {})).rejects.toMatchObject({
      code: 'validation',
      status: 422,
      message: 'Gross value is not a number',
    })
    const down: FetchLike = async () => new Response('oops', { status: 503 })
    await expect(client(down).c.get('/v2/company')).rejects.toMatchObject({ code: 'upstream' })
    const offline: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(client(offline).c.get('/v2/company')).rejects.toMatchObject({ code: 'network' })
  })

  it('never sends the token off the connection’s API host', async () => {
    const fetch = vi.fn<FetchLike>(async () => json({}))
    const { c } = client(fetch)
    await expect(c.get('https://evil.example/v2/company')).rejects.toBeInstanceOf(FreeAgentError)
    await expect(c.get('https://api.freeagent.com/v2/company')).rejects.toMatchObject({
      code: 'bad_response',
    })
    expect(c.owns(`${BASE}/v2/bank_transactions/1`)).toBe(true)
    expect(c.owns(`${BASE}/elsewhere`)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('pagination', () => {
  it('asks for 100 a page and follows rel="next" until it runs out', async () => {
    const fetch = vi.fn<FetchLike>(async input => {
      const url = new URL(String(input))
      const page = Number(url.searchParams.get('page') ?? '1')
      const next = page < 3 ? `<${BASE}/v2/contacts?page=${page + 1}&per_page=100>; rel="next"` : ''
      return json(
        { contacts: [{ url: `${BASE}/v2/contacts/${page}` }] },
        { headers: next ? { Link: next } : {} }
      )
    })
    const { c } = client(fetch)
    const all = await c.all<{ url: string }>('/v2/contacts', 'contacts', { view: 'all' })
    expect(all.map(x => x.url.split('/').pop())).toEqual(['1', '2', '3'])
    const first = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(first.searchParams.get('per_page')).toBe('100')
    expect(first.searchParams.get('view')).toBe('all')
  })

  it('stops at a next link pointing off-host', async () => {
    const fetch: FetchLike = async () =>
      json(
        { contacts: [] },
        { headers: { Link: '<https://evil.example/v2/contacts?page=2>; rel="next"' } }
      )
    await expect(client(fetch).c.all('/v2/contacts', 'contacts')).rejects.toMatchObject({
      code: 'bad_response',
    })
  })
})
