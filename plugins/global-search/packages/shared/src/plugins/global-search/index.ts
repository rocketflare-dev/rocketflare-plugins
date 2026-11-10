/**
 * `global-search` — one ⌘K palette and one `/search/all` page over everything a reader may see.
 * Shared half: the provider contract any plugin registers against, the wire contracts of
 * `GET /api/global-search`, `GET /api/global-search/providers` and the settings routes, and the
 * plugin declaration.
 *
 * **A provider is a ranked list.** Each installed plugin may contribute providers under
 * `ServerPlugin.extensions['global-search.providers']` WITHOUT importing this plugin; the route
 * calls every provider the reader may use in parallel, each with its own time budget, fuses the
 * lists with Reciprocal Rank Fusion on `href`, and optionally re-ranks the head with the
 * organisation's own re-ranker. A provider that times out or throws is reported in `degraded`,
 * never a failed request.
 *
 * **Registrations are validated at runtime** (`searchProviderRegistrationSchema`): a malformed one
 * is refused with an error naming the plugins that contributed under the key, never dropped
 * silently.
 *
 * **Everything it keys carries the plugin's id**: the table is `global_search_settings`, the API
 * prefix `/api/global-search`, query-key roots `global-search:…`, the recent-items storage key
 * `global-search:recent`, the extension key `global-search.providers`.
 *
 * **This module never imports a composer at runtime** — see the kit's `plugins/CLAUDE.md`.
 */
import { z } from 'zod'
import type { SharedPlugin } from '../types'

/** The plugin's id — and the namespace for every key below. */
export const GLOBAL_SEARCH_ID = 'global-search'

/** The `ServerPlugin.extensions` key a plugin registers its providers under. */
export const SEARCH_PROVIDERS_EXTENSION = 'global-search.providers'

/** The CASL subject the re-ranker settings are governed by. Owners and admins manage them. */
export const GLOBAL_SEARCH_CONFIG_SUBJECT = 'GlobalSearchConfig'

/** Query-key family roots. The settings root is also the `entity.changed` entity a save nudges. */
export const GLOBAL_SEARCH_SETTINGS_ENTITY = 'global-search:settings'
export const GLOBAL_SEARCH_RESULTS_ROOT = 'global-search:search'
export const GLOBAL_SEARCH_PROVIDERS_ROOT = 'global-search:providers'

/** The localStorage key the palette's recent items live under. */
export const GLOBAL_SEARCH_RECENT_KEY = 'global-search:recent'

/** The full results page; the palette's "Search everything" row links here. */
export const GLOBAL_SEARCH_PAGE_PATH = '/search/all'

/** A provider's whole answer must arrive within this, or it is reported as `timeout`. */
export const PROVIDER_TIMEOUT_MS = 1500
/** RRF's constant, as in the kit's own retrieval. */
export const RRF_K = 60
/** A hybrid hit only the DENSE half found counts this much in the fusion (see `fuse`). */
export const DENSE_ONLY_WEIGHT = 0.5
/** How many of the fused hits a re-ranker sees; the rest keep their fused order after them. */
export const RERANK_CANDIDATES = 50
/** The interactive budget for the re-ranker: past it the fused order stands, and the result says so. */
export const RERANK_TIMEOUT_MS = 1500

// ---- The provider contract ---------------------------------------------------------------------

export const SEARCH_KIND_TONES = ['neutral', 'info', 'success', 'warning', 'accent'] as const
export type SearchKindTone = (typeof SEARCH_KIND_TONES)[number]

/** A kind is a short slug (`document`, `guide-page`); it keys the palette's groups and badges. */
export const SEARCH_KIND_RE = /^[a-z][a-z0-9-]{0,39}$/
/** `<plugin id>:<list>` — `guide:pages`. The plugin half must be the registering plugin's id. */
export const SEARCH_PROVIDER_ID_RE = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/

/** What a provider says about one kind it returns: the group label, the badge and where it sorts. */
export interface SearchProviderKind {
  kind: string
  /** The group's label in the palette and the facet's on the page, plural: `Documents`. */
  label: string
  /** The badge on each row, singular: `document`. Defaults to the kind. */
  badge?: string
  tone?: SearchKindTone
  /** Ascending: lower groups come first, and win when two lists find the same `href`. */
  order: number
}

/** One thing a provider found, best first. */
export interface SearchProviderHit {
  /** One of the provider's declared `kinds`; a hit of any other kind is dropped. */
  kind: string
  title: string
  /** Plain text or markdown; the UI flattens it (`cleanSnippet`). */
  snippet: string | null
  /** The provider's own stable id for the thing (a document id, a page path). */
  ref: string
  /** An IN-APP path (`/documents/…`), never a URL: it is the fusion key and the link. */
  href: string
  /** Multiplies this hit's RRF contribution, 0..1 (default 1) — a weak match counts less. */
  weight?: number
  /** For a hybrid list: where each half placed it, 1-based, null when that half did not find it. */
  halves?: { lexical: number | null; dense: number | null }
}

/**
 * What a provider's `search` is handed besides its context.
 *
 * `kinds` is never empty: it is the subset of the provider's declared kinds this search wants, and
 * a provider none of whose kinds is wanted is not called at all. `signal` aborts at the provider's
 * time budget (`PROVIDER_TIMEOUT_MS`); pass it to `fetch` and to `searchKnowledge`.
 */
export interface SearchProviderInput {
  q: string
  /** How many hits this list may contribute before fusion. */
  pool: number
  kinds: ReadonlySet<string>
  signal: AbortSignal
  /**
   * Optional: say whether a meaning-based (embeddings) half ran for this answer, so the result can
   * tell the reader "name matches only". A provider with no semantic half never calls it.
   */
  reportSemantic?: (state: 'used' | 'unavailable') => void
}

/**
 * The request context a provider receives, generic so this shared module names no server type. The
 * server entry (`@/plugins/global-search`) exports it bound to the kit's own types:
 * `SearchProviderCtx = SearchProviderCtxOf<Database, PluginConfig, PluginBindings, AccessScope>`.
 */
export interface SearchProviderCtxOf<
  Db = unknown,
  Config = unknown,
  Env = unknown,
  Scope = unknown,
> {
  db: Db
  config: Config
  env: Env
  /** The reader's visibility scope — hand it to a predicate (or `searchKnowledge`), never a query. */
  scope: Scope
  tenantId: string
  userId: string
  /** Owner or admin of this organisation. */
  isAdmin: boolean
  /** The reader's CASL ability, for a provider that filters within its own list. */
  can(action: string, subject: string): boolean
}

/** A provider, as a plugin registers it. */
export interface SearchProviderOf<Ctx = SearchProviderCtxOf> {
  /** `<plugin id>:<list>` — the RRF list name, and the name `degraded` reports. */
  id: string
  label: string
  kinds: readonly SearchProviderKind[]
  /** CASL: the provider is skipped (not called, not listed) when the reader lacks it. */
  guard?: { action: string; subject: string }
  /**
   * Field labels this provider's snippets carry (`Question:`, `Rule:`), so `cleanSnippet` can split
   * them into fields; `noise` names the ones that only identify and are dropped. Literal strings.
   */
  snippetLabels?: {
    fields: readonly string[]
    noise?: readonly string[]
    /** Fields shown as their value alone (`Question: Can…?` → `Can…?`). */
    bare?: readonly string[]
  }
  search(ctx: Ctx, input: SearchProviderInput): Promise<SearchProviderHit[]>
}

const label = z.string().trim().min(1).max(80)

export const searchProviderKindSchema = z.object({
  kind: z.string().regex(SEARCH_KIND_RE, 'a kind is a lower-case slug'),
  label,
  badge: z.string().trim().min(1).max(40).optional(),
  tone: z.enum(SEARCH_KIND_TONES).optional(),
  order: z.number().finite(),
})

export const searchSnippetLabelsSchema = z.object({
  fields: z.array(z.string().min(1).max(60)).max(100),
  noise: z.array(z.string().min(1).max(60)).max(100).optional(),
  bare: z.array(z.string().min(1).max(60)).max(100).optional(),
})
export type SearchSnippetLabels = z.infer<typeof searchSnippetLabelsSchema>

/**
 * The runtime check every registration passes before it is called. `search` must be a function;
 * kinds are unique within a provider.
 */
export const searchProviderRegistrationSchema = z.object({
  id: z.string().regex(SEARCH_PROVIDER_ID_RE, 'a provider id is "<plugin id>:<list>"'),
  label,
  kinds: z
    .array(searchProviderKindSchema)
    .min(1)
    .max(20)
    .refine(kinds => new Set(kinds.map(k => k.kind)).size === kinds.length, {
      message: 'a kind is declared twice',
    }),
  guard: z.object({ action: z.string().min(1), subject: z.string().min(1) }).optional(),
  snippetLabels: searchSnippetLabelsSchema.optional(),
  search: z.custom<(...args: never[]) => unknown>(value => typeof value === 'function', {
    message: 'search must be a function',
  }),
})

/** An in-app path: `/x`, never `//host`, a scheme or a backslash. */
export function isInAppHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')
}

const inAppHref = z.string().min(1).max(2000).refine(isInAppHref, 'href must be an in-app path')

/** What a provider's answer must parse as; one bad hit fails the provider (`invalid_response`). */
export const searchProviderHitSchema = z.object({
  kind: z.string().regex(SEARCH_KIND_RE),
  title: z.string().min(1).max(500),
  snippet: z.string().max(8000).nullable(),
  ref: z.string().min(1).max(1000),
  href: inAppHref,
  weight: z.number().min(0).max(1).optional(),
  halves: z
    .object({
      lexical: z.number().int().min(1).nullable(),
      dense: z.number().int().min(1).nullable(),
    })
    .optional(),
})
export const searchProviderHitsSchema = z.array(searchProviderHitSchema).max(200)

// ---- GET /api/global-search -------------------------------------------------------------------

/** `GET /api/global-search?q&kinds&limit`. Unknown kinds are ignored rather than refused. */
export const globalSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  /** Comma-separated kinds; omitted = every kind. */
  kinds: z
    .string()
    .trim()
    .max(400)
    .transform(s =>
      s
        .split(',')
        .map(k => k.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().regex(SEARCH_KIND_RE)).max(40))
    .optional(),
  limit: z.coerce.number<number>().int().min(1).max(100).default(20),
})
export type GlobalSearchQuery = z.input<typeof globalSearchQuerySchema>

/**
 * One list's vote for a hit: its 1-based `rank` there and its RRF `contribution` =
 * `weight / (k + rank)`. A hybrid list also says where its halves placed it.
 */
export const searchRankSourceSchema = z.object({
  /** The provider id. */
  list: z.string(),
  rank: z.number().int().min(1),
  weight: z.number(),
  contribution: z.number(),
  lexical: z.number().int().nullable().optional(),
  dense: z.number().int().nullable().optional(),
})
export type SearchRankSource = z.infer<typeof searchRankSourceSchema>

/** Why a hit ranks where it does: the sum it was fused by, and the re-ranker's move if it ran. */
export const searchScoringSchema = z.object({
  sources: z.array(searchRankSourceSchema),
  fused: z.number(),
  rerank: z
    .object({ score: z.number(), before: z.number().int(), after: z.number().int() })
    .optional(),
})
export type SearchScoring = z.infer<typeof searchScoringSchema>

export const globalSearchHitSchema = z.object({
  kind: z.string(),
  title: z.string(),
  snippet: z.string().nullable(),
  ref: z.string(),
  href: z.string(),
  /** The provider whose list ranked it best (the first to find it). */
  provider: z.string(),
  score: z.number(),
  scoring: searchScoringSchema.optional(),
})
export type GlobalSearchHit = z.infer<typeof globalSearchHitSchema>

export const SEARCH_DEGRADED_REASONS = ['timeout', 'error', 'invalid_response'] as const
export const searchDegradedSchema = z.object({
  provider: z.string(),
  reason: z.enum(SEARCH_DEGRADED_REASONS),
})
export type SearchDegraded = z.infer<typeof searchDegradedSchema>

export const SEARCH_RERANK_SKIP_REASONS = ['not_configured', 'timeout', 'error', 'too_few'] as const
export type SearchRerankSkipReason = (typeof SEARCH_RERANK_SKIP_REASONS)[number]

/** How the list was ordered: RRF over `lists` non-empty lists, then maybe re-ranked. */
export const searchRankingSchema = z.object({
  method: z.literal('rrf'),
  k: z.number().int(),
  lists: z.number().int(),
  rerank: z.object({
    applied: z.boolean(),
    model: z.string().optional(),
    reason: z.enum(SEARCH_RERANK_SKIP_REASONS).optional(),
    latencyMs: z.number().int().optional(),
    candidates: z.number().int().optional(),
  }),
})
export type SearchRanking = z.infer<typeof searchRankingSchema>

export const SEARCH_SEMANTIC_STATES = ['used', 'unavailable', 'skipped'] as const

export const globalSearchResultSchema = z.object({
  items: z.array(globalSearchHitSchema),
  /**
   * `used` — a provider answered by meaning; `unavailable` — one could only match keywords (no
   * embeddings provider); `skipped` — no provider with a semantic half was asked.
   */
  semantic: z.enum(SEARCH_SEMANTIC_STATES),
  /** Providers that did not answer in time or failed; the rest still ranked. */
  degraded: z.array(searchDegradedSchema),
  ranking: searchRankingSchema,
})
export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>

// ---- GET /api/global-search/providers -------------------------------------------------------------

export const searchProviderInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  kinds: z.array(searchProviderKindSchema),
  snippetLabels: searchSnippetLabelsSchema.optional(),
})
export type SearchProviderInfo = z.infer<typeof searchProviderInfoSchema>

/** The providers THIS reader may use — what the palette builds its groups and badges from. */
export const searchProvidersResponseSchema = z.object({
  providers: z.array(searchProviderInfoSchema),
})
export type SearchProvidersResponse = z.infer<typeof searchProvidersResponseSchema>

// ---- Re-ranker settings -------------------------------------------------------------------------

/** Known `/rerank` endpoints. A preset is just a URL and a model; any Cohere-style server works. */
export const RERANK_PRESETS = [
  { id: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.com/v2', model: 'rerank-v3.5' },
  {
    id: 'voyage',
    name: 'Voyage AI',
    baseUrl: 'https://api.voyageai.com/v1',
    model: 'rerank-2.5-lite',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'fireworks/qwen3-reranker-8b',
  },
] as const

const API_KEY_MAX = 500

/** An `https:` URL — a re-ranker receives the reader's query and result titles. */
export const rerankBaseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(value => {
    try {
      return new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  }, 'The re-ranker URL must be an https:// URL')

/**
 * `GET|PUT /api/global-search/settings`. An organisation that never saved anything answers the
 * defaults with `updatedAt: null`. The key is never returned: `hasCredential` instead.
 */
export const globalSearchSettingsSchema = z.object({
  rerankEnabled: z.boolean(),
  rerankBaseUrl: z.string().nullable(),
  rerankModel: z.string().nullable(),
  hasCredential: z.boolean(),
  updatedAt: z.coerce.date().nullable(),
})
export type GlobalSearchSettings = z.infer<typeof globalSearchSettingsSchema>

/**
 * A partial update. `rerankApiKey` omitted keeps the stored key, `null` clears it; changing the base
 * URL without a new key clears the stored one, because a key belongs to one endpoint.
 */
export const updateGlobalSearchSettingsSchema = z
  .object({
    rerankEnabled: z.boolean().optional(),
    rerankBaseUrl: rerankBaseUrlSchema.nullable().optional(),
    rerankModel: z.string().trim().min(1).max(200).nullable().optional(),
    rerankApiKey: z.string().trim().min(1).max(API_KEY_MAX).nullable().optional(),
  })
  .refine(body => Object.keys(body).length > 0, { message: 'Nothing to update' })
export type UpdateGlobalSearchSettings = z.infer<typeof updateGlobalSearchSettingsSchema>

/** `POST /api/global-search/settings/test` — test the form's values or, with none, the saved ones. */
export const testRerankRequestSchema = z.object({
  rerankBaseUrl: rerankBaseUrlSchema.optional(),
  rerankModel: z.string().trim().min(1).max(200).optional(),
  rerankApiKey: z.string().trim().min(1).max(API_KEY_MAX).optional(),
})
export type TestRerankRequest = z.infer<typeof testRerankRequestSchema>

/** Always a 200: a failed test is an answer, rendered inline. */
export const testRerankResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), latencyMs: z.number().int(), scored: z.number().int() }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.string() }),
])
export type TestRerankResponse = z.infer<typeof testRerankResponseSchema>

// ---- The plugin ---------------------------------------------------------------------------------

export const globalSearchShared = {
  id: GLOBAL_SEARCH_ID,
  label: 'Global search',
  subjects: [GLOBAL_SEARCH_CONFIG_SUBJECT],
} as const satisfies SharedPlugin
