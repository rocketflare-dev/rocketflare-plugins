/**
 * `web-knowledge` — web search for agents and chat, on the organisation's own search API key.
 * Shared half: the provider list, the settings contracts, and the plugin declaration.
 *
 * An admin picks one provider in Settings → Web search, pastes the organisation's key and turns it
 * on. From then on that tenant's agent runs and chat turns carry two more tools, `web_search` and
 * `fetch_page`, and no other tenant's do. The key is sealed at rest (`sealSecret`) and never
 * returned: every answer carries `hasCredential` instead.
 *
 * **Everything it keys carries the plugin's id**: the table is `web_search_settings` (the id's
 * first segment is the prefix), the API prefix `/api/web-knowledge`, the query-key root
 * `web-knowledge:…`, the CLI command `rocketflare web-knowledge`, activity `web-knowledge.…`.
 *
 * **This module never imports a composer at runtime** — see the kit's `plugins/CLAUDE.md`.
 */
import { z } from 'zod'
import type { SharedPlugin } from '../types'

/** The plugin's id — and the namespace for every key below. */
export const WEB_KNOWLEDGE_ID = 'web-knowledge'

/** The CASL subject the settings are governed by. Admin-level roles manage, members read. */
export const WEB_SEARCH_CONFIG_SUBJECT = 'WebSearchConfig'

/** The query-key family root, and the `entity.changed` entity a settings write nudges. */
export const WEB_SEARCH_SETTINGS_ENTITY = 'web-knowledge:settings'

// ---- Providers ----------------------------------------------------------------------------------

export const WEB_SEARCH_PROVIDERS = ['tavily', 'brave', 'exa', 'serper', 'firecrawl'] as const
export const webSearchProviderSchema = z.enum(WEB_SEARCH_PROVIDERS)
export type WebSearchProvider = z.infer<typeof webSearchProviderSchema>

export interface WebSearchProviderInfo {
  id: WebSearchProvider
  name: string
  /** One line for the settings page: what this provider is good at. */
  description: string
  /** Where an admin gets a key. */
  keyUrl: string
  /**
   * Whether `fetch_page` can use the provider's own page extraction (which handles JavaScript-
   * rendered pages). Without it the Worker fetches the page itself.
   */
  extracts: boolean
}

/** Pure data, so the settings page reads it directly — there is no `/providers` route to drift. */
export const WEB_SEARCH_PROVIDER_INFO: Record<WebSearchProvider, WebSearchProviderInfo> = {
  tavily: {
    id: 'tavily',
    name: 'Tavily',
    description: 'Search built for LLMs: ranked, cleaned snippets, plus page extraction.',
    keyUrl: 'https://app.tavily.com/',
    extracts: true,
  },
  brave: {
    id: 'brave',
    name: 'Brave Search',
    description: 'An independent web index with a free tier. Snippets only.',
    keyUrl: 'https://api-dashboard.search.brave.com/',
    extracts: false,
  },
  exa: {
    id: 'exa',
    name: 'Exa',
    description: 'Neural search that finds pages by meaning, plus page contents.',
    keyUrl: 'https://dashboard.exa.ai/',
    extracts: true,
  },
  serper: {
    id: 'serper',
    name: 'Serper',
    description: 'Google results through a low-cost API. Snippets only.',
    keyUrl: 'https://serper.dev/',
    extracts: false,
  },
  firecrawl: {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'Search plus scraping to markdown, including JavaScript-rendered pages.',
    keyUrl: 'https://www.firecrawl.dev/app',
    extracts: true,
  },
}

/** How many results one `web_search` call may return, whatever the tenant configured. */
export const WEB_SEARCH_MAX_RESULTS = 10
export const WEB_SEARCH_DEFAULT_RESULTS = 5
const API_KEY_MAX = 500

// ---- Contracts ----------------------------------------------------------------------------------

/**
 * `GET|PUT /api/web-knowledge/settings`. An organisation that never saved anything answers the
 * defaults with `updatedAt: null` rather than a 404 — the page has one shape to render.
 */
export const webSearchSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: webSearchProviderSchema,
  hasCredential: z.boolean(),
  maxResults: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS),
  updatedAt: z.coerce.date().nullable(),
})
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>

/**
 * A partial update. `apiKey` omitted keeps the stored key, `null` clears it. Changing `provider`
 * WITHOUT a new key clears the stored one — keys are per provider, and keeping a Tavily key under
 * Brave would make every call fail with "key rejected".
 */
export const updateWebSearchSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: webSearchProviderSchema.optional(),
    apiKey: z.string().trim().min(1).max(API_KEY_MAX).nullable().optional(),
    maxResults: z.coerce.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
  })
  .refine(body => Object.keys(body).length > 0, { message: 'Nothing to update' })
export type UpdateWebSearchSettings = z.infer<typeof updateWebSearchSettingsSchema>

/**
 * `POST /api/web-knowledge/settings/test`: one live query. Both fields are optional, so the page can
 * test a key BEFORE saving it (supply both) or the saved configuration (supply neither).
 */
export const testWebSearchRequestSchema = z.object({
  provider: webSearchProviderSchema.optional(),
  apiKey: z.string().trim().min(1).max(API_KEY_MAX).optional(),
})
export type TestWebSearchRequest = z.infer<typeof testWebSearchRequestSchema>

/** Always a 200. A failed test is an answer, not an error — the page renders it inline. */
export const testWebSearchResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    provider: webSearchProviderSchema,
    latencyMs: z.number().int(),
    resultCount: z.number().int(),
  }),
  z.object({
    ok: z.literal(false),
    provider: webSearchProviderSchema,
    error: z.string(),
    code: z.string(),
  }),
])
export type TestWebSearchResponse = z.infer<typeof testWebSearchResponseSchema>

// ---- The plugin ---------------------------------------------------------------------------------

export const webKnowledgeShared = {
  id: WEB_KNOWLEDGE_ID,
  label: 'Web knowledge',
  version: '3.1.0',
  subjects: [WEB_SEARCH_CONFIG_SUBJECT],
} as const satisfies SharedPlugin
