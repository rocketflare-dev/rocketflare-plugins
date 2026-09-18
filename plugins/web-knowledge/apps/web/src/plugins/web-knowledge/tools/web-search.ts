/**
 * `web_search` — ranked results from the organisation's configured provider.
 *
 * Offered only to a tenant whose settings are enabled with a key (the `agentTools` builder in
 * `../index.ts` decides), so the handler never has to say "not configured". The key is opened here,
 * at the moment of the call, and never leaves this function.
 *
 * Bound to the RUN: the tenant comes from `ToolCtx`, and there is no provider or key on the input
 * schema for the model to choose.
 */
import { WEB_SEARCH_PROVIDER_INFO } from '@rocketflare/shared/plugins/web-knowledge/index'
import { z } from 'zod'
import type { Tool, ToolCtx } from '@/plugins/api'
import { defineTool } from '@/plugins/api'
import type { EnabledSearch } from '../api/settings'
import { openKey } from '../api/settings'
import { SEARCH_ADAPTERS } from '../services/providers'
import { toolFailure } from './errors'

export const WEB_SEARCH_TOOL = 'web_search'

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(400).describe('What to search the public web for'),
  maxResults: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('How many results (default and maximum are set by the organisation)'),
})
export type WebSearchInput = z.infer<typeof webSearchInputSchema>

export interface WebToolDeps {
  fetch: typeof fetch
}

export function webSearchTool(
  ctx: ToolCtx,
  search: EnabledSearch,
  deps: WebToolDeps
): Tool<WebSearchInput> {
  const provider = WEB_SEARCH_PROVIDER_INFO[search.provider]
  return defineTool({
    name: WEB_SEARCH_TOOL,
    description:
      `Search the public web (via ${provider.name}) for current information that is not in this ` +
      'workspace’s knowledge base: news, recent releases, public documentation, prices. ' +
      'Answers titles, URLs and snippets; call fetch_page on a result to read it in full. ' +
      'Cite the URLs you use.',
    schema: webSearchInputSchema,
    async handler(input) {
      const limit = Math.min(input.maxResults ?? search.maxResults, search.maxResults)
      try {
        const apiKey = await openKey(ctx.config, search.apiKeyEnc)
        const results = await SEARCH_ADAPTERS[search.provider].search(
          { apiKey, fetch: deps.fetch },
          input.query,
          limit
        )
        return JSON.stringify({
          query: input.query,
          provider: search.provider,
          results,
          ...(results.length === 0 && {
            hint: 'Nothing matched. Try fewer or broader terms once, then answer without the web.',
          }),
        })
      } catch (err) {
        return toolFailure(err, 'Web search failed')
      }
    },
  })
}
