/**
 * Global search — the one core behind `GET /api/global-search` (the ⌘K palette and `/search/all`).
 *
 * 1. **Who may ask what.** A provider whose `guard` the reader fails is not called and not listed.
 *    A provider none of whose kinds the request wants is not called either.
 * 2. **Fan-out.** Every remaining provider is called IN PARALLEL with its own `AbortSignal` and a
 *    budget of `PROVIDER_TIMEOUT_MS`. A provider that runs past it is reported as `timeout`
 *    (whether or not it honours the signal — the race does not wait), one that throws as `error`,
 *    one whose answer does not parse as `invalid_response`. None of them fails the request.
 * 3. **Fusion.** Reciprocal Rank Fusion (`RRF_K`) over the lists, keyed by `href`: the same thing
 *    found by two providers is ONE hit, scored by both. Each hit contributes
 *    `weight / (k + rank)`; a hybrid hit only the dense half found counts `DENSE_ONLY_WEIGHT`
 *    (the documents provider sets it), so a navigational query does not lose its exact name match
 *    to an unrelated nearest neighbour. When two lists name one href with different kinds, the
 *    kind with the lower `order` names it.
 * 4. **Re-ranking**, optional: the organisation's re-ranker reorders the top `RERANK_CANDIDATES`
 *    within `RERANK_TIMEOUT_MS`; none, a timeout or a failure keeps the fused order and
 *    `ranking.rerank` says why.
 *
 * Tenant isolation is the providers' own: each receives the reader's `scope` and `tenantId` and
 * nothing else to query with.
 */
import {
  DENSE_ONLY_WEIGHT,
  type GlobalSearchHit,
  type GlobalSearchResult,
  PROVIDER_TIMEOUT_MS,
  RERANK_CANDIDATES,
  RERANK_TIMEOUT_MS,
  RRF_K,
  type SearchDegraded,
  type SearchProviderHit,
  type SearchRanking,
  type SearchScoring,
  type SearchSnippetLabels,
  searchProviderHitsSchema,
} from '@rocketflare/shared/plugins/global-search/index'
import { cleanSnippet } from '@rocketflare/shared/plugins/global-search/search-text'
import type { PluginLogger } from '@/plugins/api'
import type { SearchProvider, SearchProviderCtx } from '../types'
import { applyRerank, type RerankClient } from './rerank'

export { DENSE_ONLY_WEIGHT }

/** A ranked list: one provider's answer. */
export interface RankedList {
  list: string
  hits: SearchProviderHit[]
}

interface FusedHit extends GlobalSearchHit {
  scoring: SearchScoring
}

/**
 * RRF over the ranked lists, one hit per href. Each hit records every list that voted for it —
 * its rank there and its contribution `weight / (RRF_K + rank)` — so `scoring.fused` is exactly
 * the sum the order was decided by. Ties break on href, so the order is deterministic. Pure.
 */
export function fuse(
  lists: readonly RankedList[],
  kindOrder: (kind: string) => number = () => 0
): FusedHit[] {
  const merged = new Map<string, FusedHit>()
  for (const { list, hits } of lists) {
    hits.forEach((hit, index) => {
      const weight = hit.weight ?? 1
      const add = weight / (RRF_K + index + 1)
      const source = {
        list,
        rank: index + 1,
        weight,
        contribution: add,
        ...(hit.halves ? { lexical: hit.halves.lexical, dense: hit.halves.dense } : {}),
      }
      const prior = merged.get(hit.href)
      if (!prior) {
        merged.set(hit.href, {
          kind: hit.kind,
          title: hit.title,
          snippet: hit.snippet,
          ref: hit.ref,
          href: hit.href,
          provider: list,
          score: add,
          scoring: { sources: [source], fused: add },
        })
        return
      }
      prior.score += add
      prior.scoring.sources.push(source)
      prior.scoring.fused = prior.score
      if (kindOrder(hit.kind) < kindOrder(prior.kind)) prior.kind = hit.kind
      prior.snippet ??= hit.snippet
    })
  }
  return [...merged.values()].sort(
    (a, b) => b.score - a.score || (a.href < b.href ? -1 : a.href > b.href ? 1 : 0)
  )
}

/** What a re-ranker reads for a hit: its title and the snippet as a person reads it. */
export function rerankText(
  hit: Pick<GlobalSearchHit, 'title' | 'snippet'>,
  labels?: SearchSnippetLabels
): string {
  const body = cleanSnippet(hit.snippet, hit.title, labels)
  return body ? `${hit.title}\n${body}` : hit.title
}

/** The providers this reader may use: each one's guard, checked with the reader's ability. */
export function usableProviders(
  providers: readonly SearchProvider[],
  can: (action: string, subject: string) => boolean
): SearchProvider[] {
  return providers.filter(p => !p.guard || can(p.guard.action, p.guard.subject))
}

class ProviderTimeout extends Error {}

export interface FanOutResult {
  lists: RankedList[]
  degraded: SearchDegraded[]
  semantic: GlobalSearchResult['semantic']
}

/**
 * Call every provider in parallel, each within `timeoutMs`, and collect its list — or why it has
 * none. Hits of a kind the provider was not asked for are dropped. Never throws.
 */
export async function fanOut(
  providers: readonly SearchProvider[],
  ctx: SearchProviderCtx,
  input: { q: string; pool: number; wanted: ReadonlySet<string> | null },
  options: { timeoutMs?: number; logger?: PluginLogger } = {}
): Promise<FanOutResult> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const semanticReports: ('used' | 'unavailable')[] = []
  const degraded: SearchDegraded[] = []
  const lists: RankedList[] = []
  await Promise.all(
    providers.map(async provider => {
      const declared = provider.kinds.map(k => k.kind)
      const kinds = new Set(input.wanted ? declared.filter(k => input.wanted?.has(k)) : declared)
      if (kinds.size === 0) return
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new ProviderTimeout())
        }, timeoutMs)
      })
      let settled = false
      try {
        const raw = await Promise.race([
          Promise.resolve().then(() =>
            provider.search(ctx, {
              q: input.q,
              pool: input.pool,
              kinds,
              signal: controller.signal,
              reportSemantic: state => {
                if (!settled) semanticReports.push(state)
              },
            })
          ),
          deadline,
        ])
        const parsed = searchProviderHitsSchema.safeParse(raw)
        if (!parsed.success) {
          options.logger?.warn(
            { provider: provider.id, issue: parsed.error.issues[0]?.message },
            'global-search: provider answered an invalid list'
          )
          degraded.push({ provider: provider.id, reason: 'invalid_response' })
          return
        }
        lists.push({ list: provider.id, hits: parsed.data.filter(h => kinds.has(h.kind)) })
      } catch (err) {
        const reason = err instanceof ProviderTimeout ? 'timeout' : 'error'
        options.logger?.warn(
          { provider: provider.id, reason, err: err instanceof Error ? err.message : String(err) },
          'global-search: provider did not answer'
        )
        degraded.push({ provider: provider.id, reason })
      } finally {
        settled = true
        clearTimeout(timer)
      }
    })
  )
  // Deterministic list order (the fan-out finishes in any order): registration order.
  const order = new Map(providers.map((p, i) => [p.id, i]))
  lists.sort((a, b) => (order.get(a.list) ?? 0) - (order.get(b.list) ?? 0))
  degraded.sort((a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0))
  const semantic = semanticReports.includes('unavailable')
    ? 'unavailable'
    : semanticReports.includes('used')
      ? 'used'
      : 'skipped'
  return { lists, degraded, semantic }
}

export interface GlobalSearchInput {
  q: string
  /** Omitted or empty = every kind. */
  kinds?: readonly string[]
  limit: number
}

export interface GlobalSearchDeps {
  /** The organisation's re-ranker, resolved only when there is something to re-rank. */
  reranker?: () => Promise<RerankClient | null>
  logger?: PluginLogger
  timeoutMs?: number
  rerankTimeoutMs?: number
}

/**
 * Search everything this reader may see. `providers` are already guard-filtered
 * (`usableProviders`). Never throws for a provider or re-ranker failure.
 */
export async function globalSearch(
  providers: readonly SearchProvider[],
  ctx: SearchProviderCtx,
  input: GlobalSearchInput,
  deps: GlobalSearchDeps = {}
): Promise<GlobalSearchResult> {
  const wanted = input.kinds?.length ? new Set(input.kinds) : null
  const pool = Math.min(Math.max(input.limit * 2, 20), 100)
  const { lists, degraded, semantic } = await fanOut(
    providers,
    ctx,
    { q: input.q, pool, wanted },
    { timeoutMs: deps.timeoutMs, logger: deps.logger }
  )

  const kindOrder = new Map<string, number>()
  const labelsByKind = new Map<string, SearchSnippetLabels | undefined>()
  for (const p of providers) {
    for (const k of p.kinds) {
      kindOrder.set(k.kind, k.order)
      labelsByKind.set(k.kind, p.snippetLabels as SearchSnippetLabels | undefined)
    }
  }
  const fused = fuse(lists, kind => kindOrder.get(kind) ?? Number.POSITIVE_INFINITY)

  // The re-ranker sees the top of the FUSED list (at least `limit`, so it can promote from below
  // the cut) and reorders it; everything past what it saw keeps the fused order.
  const candidates = Math.max(input.limit, RERANK_CANDIDATES)
  let client: RerankClient | null = null
  let resolveFailed = false
  if (fused.length >= 2 && deps.reranker) {
    try {
      client = await deps.reranker()
    } catch (err) {
      resolveFailed = true
      deps.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'global-search: the re-ranker could not be resolved'
      )
    }
  }
  const reranked = resolveFailed
    ? { items: fused, placements: new Map(), outcome: { applied: false, reason: 'error' as const } }
    : await applyRerank(
        client,
        input.q,
        fused,
        hit => rerankText(hit, labelsByKind.get(hit.kind)),
        { candidates, timeoutMs: deps.rerankTimeoutMs ?? RERANK_TIMEOUT_MS }
      )
  for (const [hit, placement] of reranked.placements) {
    hit.scoring = { ...hit.scoring, rerank: placement }
  }
  const ranking: SearchRanking = {
    method: 'rrf',
    k: RRF_K,
    lists: lists.filter(l => l.hits.length > 0).length,
    rerank: {
      ...reranked.outcome,
      ...(reranked.outcome.applied ? { candidates: Math.min(candidates, fused.length) } : {}),
    },
  }
  return {
    items: reranked.items.slice(0, input.limit),
    semantic,
    degraded,
    ranking,
  }
}
