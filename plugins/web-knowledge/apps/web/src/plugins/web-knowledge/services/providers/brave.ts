/** Brave Search — `GET /res/v1/web/search`, `X-Subscription-Token`. Snippets only, no extraction. */
import { hit, hits, path, providerJson, type SearchAdapter } from './types'

export const brave: SearchAdapter = {
  async search(call, query, maxResults) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(maxResults))
    const body = await providerJson(call, 'Brave Search', url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json', 'x-subscription-token': call.apiKey },
    })
    return hits(path(body, 'web', 'results'), r =>
      hit({ title: r.title, url: r.url, snippet: r.description, publishedAt: r.page_age ?? r.age })
    )
  },
}
