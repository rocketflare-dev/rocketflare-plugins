/**
 * The guide's provider for the `global-search` plugin (⌘K), contributed under
 * `extensions['global-search.providers']`. Structural only: this plugin neither imports nor
 * requires `global-search`, so the entry is inert until that plugin is installed and reads it.
 *
 * The contract it meets: an id `guide:<list>`, unique kind slugs, at most `pool` hits, each `href`
 * an in-app path, `weight` in 0..1 (0.5 for a hit only the dense half found), the search mode
 * reported through `reportSemantic`, and `input.signal` passed on to `searchKnowledge`.
 *
 * One hit per page section, linking to `/guide?path=<path>#<heading>`, for the caller's audience.
 */
import { SEARCH_MAX_LIMIT } from '@rocketflare/shared/ai/embeddings'
import type { AccessScope, PluginBindings, PluginConfig, PluginContext } from '@/plugins/api'
import { type GuidePassage, searchGuide } from './search'

export interface GlobalSearchProviderCtx {
  db: PluginContext['db']
  config: PluginConfig
  env: PluginBindings
  scope: AccessScope
  tenantId: string
  userId: string
  isAdmin: boolean
  can?: (action: string, subject: string) => boolean
}

export interface GlobalSearchProviderInput {
  q: string
  pool: number
  kinds: ReadonlySet<string>
  signal: AbortSignal
  reportSemantic?: (state: 'used' | 'unavailable') => void
}

export interface GlobalSearchHit {
  kind: 'guide'
  title: string
  snippet: string | null
  ref: string
  href: string
  weight?: number
  halves?: { lexical: number | null; dense: number | null }
}

export const GUIDE_SEARCH_KIND = 'guide'

/** Found by both halves 1, by keyword only 0.8, by meaning only 0.5. */
export function guideHitWeight(p: Pick<GuidePassage, 'denseRank' | 'lexicalRank'>): number {
  if (p.lexicalRank !== null && p.denseRank !== null) return 1
  return p.lexicalRank !== null ? 0.8 : 0.5
}

export const guideGlobalSearchProvider = {
  id: 'guide:pages',
  label: 'User guide',
  kinds: [
    { kind: GUIDE_SEARCH_KIND, label: 'User guide', badge: 'Guide', tone: 'info', order: 50 },
  ],
  async search(
    ctx: GlobalSearchProviderCtx,
    input: GlobalSearchProviderInput
  ): Promise<GlobalSearchHit[]> {
    if (input.kinds.size > 0 && !input.kinds.has(GUIDE_SEARCH_KIND)) return []
    if (input.signal.aborted) return []
    const pool = Math.max(1, Math.trunc(input.pool))
    const { passages, semantic } = await searchGuide(ctx, {
      query: input.q,
      limit: Math.min(pool, SEARCH_MAX_LIMIT),
      isAdmin: ctx.isAdmin,
      signal: input.signal,
    })
    input.reportSemantic?.(semantic)
    return passages.slice(0, pool).map(p => ({
      kind: GUIDE_SEARCH_KIND,
      title: p.title,
      snippet: p.snippet || null,
      ref: p.heading ? `${p.path}#${p.heading}` : p.path,
      href: p.href,
      weight: guideHitWeight(p),
      halves: { lexical: p.lexicalRank, dense: p.denseRank },
    }))
  },
} as const
