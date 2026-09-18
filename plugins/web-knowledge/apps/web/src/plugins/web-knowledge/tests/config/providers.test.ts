/**
 * The provider adapters and the page fetcher, with no database and no network: each adapter is
 * handed a fake `fetch`, so these pin the request each provider is sent, the normalisation of what
 * comes back, and the status → error-code mapping the tools' hints depend on.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchPageDirect, guardUrl, htmlToText } from '../../services/fetch-page'
import { SEARCH_ADAPTERS, WebSearchError } from '../../services/providers'

type Captured = { url: string; init: RequestInit | undefined }

function fakeFetch(body: unknown, status = 200) {
  const calls: Captured[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Response.json(body, { status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const header = (c: Captured, name: string) => new Headers(c.init?.headers).get(name)
const bodyOf = (c: Captured) => JSON.parse(String(c.init?.body))

describe('search adapters', () => {
  it('tavily', async () => {
    const { fetch, calls } = fakeFetch({
      results: [
        { title: 'T', url: 'https://t.example', content: 'snip', published_date: '2026-01-01' },
      ],
    })
    const hits = await SEARCH_ADAPTERS.tavily.search({ apiKey: 'k', fetch }, 'q', 4)
    expect(calls[0]?.url).toBe('https://api.tavily.com/search')
    expect(header(calls[0] as Captured, 'authorization')).toBe('Bearer k')
    expect(bodyOf(calls[0] as Captured)).toMatchObject({ query: 'q', max_results: 4 })
    expect(hits).toEqual([
      { title: 'T', url: 'https://t.example', snippet: 'snip', publishedAt: '2026-01-01' },
    ])
  })

  it('brave', async () => {
    const { fetch, calls } = fakeFetch({
      web: { results: [{ title: 'B', url: 'https://b.example', description: 'd', page_age: 'x' }] },
    })
    const hits = await SEARCH_ADAPTERS.brave.search({ apiKey: 'k', fetch }, 'hello world', 2)
    const url = new URL(calls[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(url.searchParams.get('q')).toBe('hello world')
    expect(url.searchParams.get('count')).toBe('2')
    expect(header(calls[0] as Captured, 'x-subscription-token')).toBe('k')
    expect(hits[0]).toMatchObject({ title: 'B', url: 'https://b.example', snippet: 'd' })
  })

  it('exa joins highlights into the snippet', async () => {
    const { fetch, calls } = fakeFetch({
      results: [{ title: 'E', url: 'https://e.example', highlights: ['one', 'two'] }],
    })
    const hits = await SEARCH_ADAPTERS.exa.search({ apiKey: 'k', fetch }, 'q', 3)
    expect(calls[0]?.url).toBe('https://api.exa.ai/search')
    expect(header(calls[0] as Captured, 'x-api-key')).toBe('k')
    expect(bodyOf(calls[0] as Captured)).toMatchObject({ query: 'q', numResults: 3 })
    expect(hits[0]?.snippet).toBe('one … two')
  })

  it('serper', async () => {
    const { fetch, calls } = fakeFetch({
      organic: [{ title: 'S', link: 'https://s.example', snippet: 's' }],
    })
    const hits = await SEARCH_ADAPTERS.serper.search({ apiKey: 'k', fetch }, 'q', 5)
    expect(calls[0]?.url).toBe('https://google.serper.dev/search')
    expect(header(calls[0] as Captured, 'x-api-key')).toBe('k')
    expect(bodyOf(calls[0] as Captured)).toEqual({ q: 'q', num: 5 })
    expect(hits[0]).toMatchObject({ url: 'https://s.example', snippet: 's' })
  })

  it('firecrawl reads v2 `data.web` and v1 `data`', async () => {
    const v2 = fakeFetch({
      data: { web: [{ title: 'F', url: 'https://f.example', description: 'f' }] },
    })
    expect(
      await SEARCH_ADAPTERS.firecrawl.search({ apiKey: 'k', fetch: v2.fetch }, 'q', 1)
    ).toHaveLength(1)
    expect(v2.calls[0]?.url).toBe('https://api.firecrawl.dev/v2/search')
    expect(header(v2.calls[0] as Captured, 'authorization')).toBe('Bearer k')
    const v1 = fakeFetch({ data: [{ title: 'F', url: 'https://f.example' }] })
    expect(
      await SEARCH_ADAPTERS.firecrawl.search({ apiKey: 'k', fetch: v1.fetch }, 'q', 1)
    ).toHaveLength(1)
  })

  it('drops hits with no URL', async () => {
    const { fetch } = fakeFetch({ organic: [{ title: 'no link' }, { link: 'https://ok.example' }] })
    const hits = await SEARCH_ADAPTERS.serper.search({ apiKey: 'k', fetch }, 'q', 5)
    expect(hits).toEqual([{ title: 'https://ok.example', url: 'https://ok.example', snippet: '' }])
  })

  it.each([
    [401, 'key_rejected'],
    [403, 'key_rejected'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ] as const)('HTTP %i → %s on every provider', async (status, code) => {
    for (const adapter of Object.values(SEARCH_ADAPTERS)) {
      const { fetch } = fakeFetch({}, status)
      await expect(adapter.search({ apiKey: 'k', fetch }, 'q', 1)).rejects.toMatchObject({ code })
    }
  })

  it('reads a bad key from the body when the status does not say so (Brave: 422)', async () => {
    const { fetch } = fakeFetch(
      { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', status: 422 }, type: 'ErrorResponse' },
      422
    )
    await expect(
      SEARCH_ADAPTERS.brave.search({ apiKey: 'k', fetch }, 'q', 1)
    ).rejects.toMatchObject({ code: 'key_rejected' })
    const other = fakeFetch({ error: { code: 'VALIDATION', detail: 'q too long' } }, 422)
    await expect(
      SEARCH_ADAPTERS.brave.search({ apiKey: 'k', fetch: other.fetch }, 'q', 1)
    ).rejects.toMatchObject({ code: 'provider_error' })
  })

  it('a network failure is provider_error', async () => {
    const fetch = (async () => {
      throw new TypeError('network')
    }) as unknown as typeof globalThis.fetch
    await expect(
      SEARCH_ADAPTERS.tavily.search({ apiKey: 'k', fetch }, 'q', 1)
    ).rejects.toBeInstanceOf(WebSearchError)
  })
})

describe('extract adapters', () => {
  it('tavily answers raw_content, and a failed result is an error', async () => {
    const ok = fakeFetch({ results: [{ url: 'https://x.example', raw_content: '# Hi' }] })
    expect(
      await SEARCH_ADAPTERS.tavily.extract?.({ apiKey: 'k', fetch: ok.fetch }, 'https://x.example')
    ).toEqual({
      url: 'https://x.example',
      content: '# Hi',
    })
    const failed = fakeFetch({ results: [], failed_results: [{ url: 'u', error: 'blocked' }] })
    await expect(
      SEARCH_ADAPTERS.tavily.extract?.({ apiKey: 'k', fetch: failed.fetch }, 'https://x.example')
    ).rejects.toThrow(/blocked/)
  })

  it('firecrawl answers data.markdown', async () => {
    const { fetch, calls } = fakeFetch({ data: { markdown: 'md', metadata: { title: 'T' } } })
    expect(
      await SEARCH_ADAPTERS.firecrawl.extract?.({ apiKey: 'k', fetch }, 'https://x.example')
    ).toEqual({
      url: 'https://x.example',
      content: 'md',
      title: 'T',
    })
    expect(calls[0]?.url).toBe('https://api.firecrawl.dev/v2/scrape')
  })

  it('brave and serper have no extraction', () => {
    expect(SEARCH_ADAPTERS.brave.extract).toBeUndefined()
    expect(SEARCH_ADAPTERS.serper.extract).toBeUndefined()
  })
})

describe('guardUrl', () => {
  it.each([
    'http://localhost/',
    'http://LOCALHOST./x',
    'http://api.localhost/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://0x7f.0.0.1/',
    'http://2130706433/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://router/',
    'http://printer.local/',
    'http://db.internal/',
    'https://example.com:8443/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'https://user:pw@example.com/',
    'not a url',
  ])('refuses %s', url => {
    expect(guardUrl(url).ok).toBe(false)
  })

  it.each(['https://example.com/a?b=c', 'http://news.example.co.uk:80/', 'https://x.example:443/'])(
    'allows %s',
    url => {
      expect(guardUrl(url).ok).toBe(true)
    }
  )
})

describe('fetchPageDirect', () => {
  it('re-checks every redirect hop, so a public page cannot bounce to localhost', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://localhost:8080/admin' } })
    ) as unknown as typeof globalThis.fetch
    await expect(
      fetchPageDirect('https://example.com/', { fetch, converter: null })
    ).rejects.toThrow(/localhost/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('follows a public redirect and converts HTML with the AI binding when there is one', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === 'https://example.com/'
        ? new Response(null, { status: 301, headers: { location: '/final' } })
        : new Response('<html><title>Hi</title><body><p>Body</p></body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
    ) as unknown as typeof globalThis.fetch
    const converter = { toMarkdown: vi.fn(async () => ({ format: 'markdown', data: '# Body' })) }
    const page = await fetchPageDirect('https://example.com/', { fetch, converter })
    expect(page).toEqual({ url: 'https://example.com/final', title: 'Hi', content: '# Body' })
  })

  it('falls back to plain text without the binding', async () => {
    const fetch = (async () =>
      new Response('<p>A &amp; B</p><script>evil()</script><p>C</p>', {
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof globalThis.fetch
    const page = await fetchPageDirect('https://example.com/', { fetch, converter: null })
    expect(page.content).toBe('A & B\nC')
  })

  it('refuses a binary type it cannot read', async () => {
    const fetch = (async () =>
      new Response('x', {
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof globalThis.fetch
    await expect(
      fetchPageDirect('https://example.com/', { fetch, converter: null })
    ).rejects.toThrow(/image\/png/)
  })
})

describe('htmlToText', () => {
  it('keeps block breaks and decodes entities', () => {
    expect(htmlToText('<h1>T</h1><p>a&nbsp;b &#39;c&#x27;</p><style>x{}</style>')).toBe(
      "T\na b 'c'"
    )
  })
})
