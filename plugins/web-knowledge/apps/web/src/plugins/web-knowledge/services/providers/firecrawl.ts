/** Firecrawl — v2 `POST /search` and `POST /scrape` (markdown), Bearer auth. https://docs.firecrawl.dev */
import { hit, hits, path, providerJson, type SearchAdapter, WebSearchError } from './types'

const BASE = 'https://api.firecrawl.dev/v2'

export const firecrawl: SearchAdapter = {
  async search(call, query, maxResults) {
    const body = await providerJson(call, 'Firecrawl', `${BASE}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${call.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit: maxResults }),
    })
    // v2 groups results by source (`data.web`); tolerate the v1 flat `data` array too.
    const data = path(body, 'data')
    const items = Array.isArray(data) ? data : path(data, 'web')
    return hits(items, r => hit({ title: r.title, url: r.url, snippet: r.description }))
  },
  async extract(call, url) {
    const body = await providerJson(call, 'Firecrawl', `${BASE}/scrape`, {
      method: 'POST',
      headers: { authorization: `Bearer ${call.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    })
    const content = path(body, 'data', 'markdown')
    if (typeof content !== 'string') {
      throw new WebSearchError('provider_error', 'Firecrawl returned no markdown for the page')
    }
    const title = path(body, 'data', 'metadata', 'title')
    return { url, content, ...(typeof title === 'string' && { title }) }
  },
}
