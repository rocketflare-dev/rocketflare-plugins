/**
 * The two tools one `tools` call offers. Not exported from the server entry: nothing outside this
 * plugin builds them, and the entry is what other units may call (kit 0.48.0 checks every function
 * there for `definePublic`).
 */
import type { Tool, ToolCtx } from '@/plugins/api'
import type { EnabledSearch } from '../api/settings'
import { fetchPageTool } from './fetch-page'
import { reachableUrls } from './reachable-urls'
import { type WebToolDeps, webSearchTool } from './web-search'

/** Unbound `fetch` throws "Illegal invocation" on Workers once it is called as a method. */
const boundFetch: WebToolDeps['fetch'] = (input, init) => fetch(input, init)

/**
 * The two tools for one `tools` call, sharing one `ReachableUrls`: what `web_search` returns
 * to them, plus the URLs the person typed themselves (`ctx.requesterUrls` — their own chat turns or
 * the run input they submitted), so a pasted link can be read without a search first. Nothing the
 * model, a page or a document supplies is in either.
 */
export function webTools(
  ctx: ToolCtx,
  search: EnabledSearch,
  fetch: WebToolDeps['fetch'] = boundFetch
): Tool[] {
  const deps: WebToolDeps = { fetch, reachable: reachableUrls([...ctx.requesterUrls]) }
  return [webSearchTool(ctx, search, deps) as Tool, fetchPageTool(ctx, search, deps) as Tool]
}
