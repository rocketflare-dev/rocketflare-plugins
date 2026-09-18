/** Serper (Google results) — `POST google.serper.dev/search`, `X-API-KEY`. Snippets only. */
import { hit, hits, path, providerJson, type SearchAdapter } from './types'

export const serper: SearchAdapter = {
  async search(call, query, maxResults) {
    const body = await providerJson(call, 'Serper', 'https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'x-api-key': call.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, num: maxResults }),
    })
    return hits(path(body, 'organic'), r =>
      hit({ title: r.title, url: r.link, snippet: r.snippet, publishedAt: r.date })
    )
  },
}
