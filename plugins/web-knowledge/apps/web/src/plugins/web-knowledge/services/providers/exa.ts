/** Exa — `POST /search` (with highlights) and `POST /contents`, `x-api-key`. https://exa.ai/docs */
import { hit, hits, path, providerJson, type SearchAdapter, WebSearchError } from './types'

const BASE = 'https://api.exa.ai'

function snippetOf(r: Record<string, unknown>): unknown {
  const highlights = r.highlights
  if (Array.isArray(highlights) && highlights.length > 0) return highlights.join(' … ')
  return r.summary ?? r.text
}

export const exa: SearchAdapter = {
  async search(call, query, maxResults) {
    const body = await providerJson(call, 'Exa', `${BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': call.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        numResults: maxResults,
        type: 'auto',
        contents: { highlights: true },
      }),
    })
    return hits(path(body, 'results'), r =>
      hit({ title: r.title, url: r.url, snippet: snippetOf(r), publishedAt: r.publishedDate })
    )
  },
  async extract(call, url) {
    const body = await providerJson(call, 'Exa', `${BASE}/contents`, {
      method: 'POST',
      headers: { 'x-api-key': call.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [url], text: true }),
    })
    const first = path(body, 'results', '0')
    const content = path(first, 'text')
    if (typeof content !== 'string') {
      throw new WebSearchError('provider_error', 'Exa returned no contents for the page')
    }
    const title = path(first, 'title')
    return { url, content, ...(typeof title === 'string' && { title }) }
  },
}
