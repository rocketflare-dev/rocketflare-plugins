/** Tavily — `POST /search` and `POST /extract`, Bearer auth. https://docs.tavily.com */
import { hit, hits, path, providerJson, type SearchAdapter, WebSearchError } from './types'

const BASE = 'https://api.tavily.com'

export const tavily: SearchAdapter = {
  async search(call, query, maxResults) {
    const body = await providerJson(call, 'Tavily', `${BASE}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${call.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    })
    return hits(path(body, 'results'), r =>
      hit({ title: r.title, url: r.url, snippet: r.content, publishedAt: r.published_date })
    )
  },
  async extract(call, url) {
    const body = await providerJson(call, 'Tavily', `${BASE}/extract`, {
      method: 'POST',
      headers: { authorization: `Bearer ${call.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [url], format: 'markdown' }),
    })
    const first = path(body, 'results', '0')
    const content = path(first, 'raw_content')
    if (typeof content !== 'string') {
      const reason = path(body, 'failed_results', '0', 'error')
      throw new WebSearchError(
        'provider_error',
        `Tavily could not extract the page${typeof reason === 'string' ? `: ${reason}` : ''}`
      )
    }
    return { url, content }
  },
}
