/**
 * The pure half of search (the ⌘K palette and `/search/all`): the kind index built from the
 * providers' metadata, grouping, the palette's balancing, snippet cleanup, the ranking in words,
 * and the recent-items list kept in localStorage. No React, so it is unit-tested.
 */
import {
  GLOBAL_SEARCH_RECENT_KEY,
  type GlobalSearchHit,
  isInAppHref,
  SEARCH_KIND_RE,
  type SearchKindTone,
  type SearchProviderInfo,
  type SearchRanking,
  type SearchScoring,
  type SearchSnippetLabels,
} from '@rocketflare/shared/plugins/global-search/index'
import { cleanSnippet } from '@rocketflare/shared/plugins/global-search/search-text'

export {
  cleanSnippet,
  flattenMarkdown,
} from '@rocketflare/shared/plugins/global-search/search-text'

/** Everything the UI knows about one kind, from the provider that declares it. */
export interface KindInfo {
  kind: string
  label: string
  badge: string
  tone: SearchKindTone
  order: number
  provider: string
  snippetLabels?: SearchSnippetLabels
}

export interface KindIndex {
  kinds: KindInfo[]
  get(kind: string): KindInfo
  /** Provider id → its label, for the ranking indicators. */
  providerLabel(id: string): string
}

/** The kind index from `GET /api/global-search/providers`; an unknown kind gets a plain fallback. */
export function kindIndex(providers: readonly SearchProviderInfo[] | undefined): KindIndex {
  const by = new Map<string, KindInfo>()
  const labels = new Map<string, string>()
  for (const p of providers ?? []) {
    labels.set(p.id, p.label)
    for (const k of p.kinds) {
      by.set(k.kind, {
        kind: k.kind,
        label: k.label,
        badge: k.badge ?? k.kind,
        tone: k.tone ?? 'neutral',
        order: k.order,
        provider: p.id,
        ...(p.snippetLabels ? { snippetLabels: p.snippetLabels } : {}),
      })
    }
  }
  const kinds = [...by.values()].sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind))
  return {
    kinds,
    get: kind =>
      by.get(kind) ?? {
        kind,
        label: kind,
        badge: kind,
        tone: 'neutral',
        order: Number.POSITIVE_INFINITY,
        provider: '',
      },
    providerLabel: id => labels.get(id) ?? id,
  }
}

export interface HitGroup {
  kind: string
  label: string
  hits: GlobalSearchHit[]
}

/** Hits grouped by kind in the kinds' `order`; within a group the server's rank order is kept. */
export function groupHits(hits: readonly GlobalSearchHit[], index: KindIndex): HitGroup[] {
  const by = new Map<string, GlobalSearchHit[]>()
  for (const hit of hits) {
    const list = by.get(hit.kind)
    if (list) list.push(hit)
    else by.set(hit.kind, [hit])
  }
  return [...by.keys()]
    .sort((a, b) => index.get(a).order - index.get(b).order || a.localeCompare(b))
    .map(kind => ({ kind, label: index.get(kind).label, hits: by.get(kind) ?? [] }))
}

/** A hit's snippet as a person reads it, with its provider's field labels. */
export function hitSnippet(
  hit: Pick<GlobalSearchHit, 'kind' | 'snippet' | 'title'>,
  index: KindIndex
): string | null {
  return cleanSnippet(hit.snippet, hit.title, index.get(hit.kind).snippetLabels)
}

/**
 * The palette's share of a long ranked list: at most `perKind` per kind in rank order, so one
 * kind cannot fill every row; slots left over are filled by the best remaining hits, whatever
 * their kind, up to `total`. Rank order is kept.
 */
export function balanceHits<T extends { kind: string }>(
  hits: readonly T[],
  options: { perKind: number; total: number }
): T[] {
  const taken = new Set<T>()
  const perKind = new Map<string, number>()
  for (const hit of hits) {
    if (taken.size >= options.total) break
    const n = perKind.get(hit.kind) ?? 0
    if (n >= options.perKind) continue
    perKind.set(hit.kind, n + 1)
    taken.add(hit)
  }
  for (const hit of hits) {
    if (taken.size >= options.total) break
    taken.add(hit)
  }
  return hits.filter(h => taken.has(h))
}

// ---- recent items --------------------------------------------------------------------------------

export const RECENT_KEY = GLOBAL_SEARCH_RECENT_KEY
export const RECENT_MAX = 8

/** What a recent entry keeps: enough to show and follow it, nothing the server would re-check. */
export type RecentHit = Pick<GlobalSearchHit, 'kind' | 'title' | 'href' | 'ref'>

function isRecent(value: unknown): value is RecentHit {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.title === 'string' &&
    typeof v.href === 'string' &&
    typeof v.ref === 'string' &&
    typeof v.kind === 'string' &&
    SEARCH_KIND_RE.test(v.kind) &&
    // Only in-app paths: a tampered entry must never become an off-site link.
    isInAppHref(v.href)
  )
}

/** The stored list, newest first; anything unreadable is dropped rather than trusted. */
export function readRecent(storage: Pick<Storage, 'getItem'> = localStorage): RecentHit[] {
  try {
    const raw = storage.getItem(RECENT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed
          .filter(isRecent)
          .slice(0, RECENT_MAX)
          .map(r => ({ kind: r.kind, title: r.title, href: r.href, ref: r.ref }))
      : []
  } catch {
    return []
  }
}

/** Put `hit` first (moving it if it was already there) and keep `RECENT_MAX`. */
export function pushRecent(
  hit: RecentHit,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage
): RecentHit[] {
  const entry: RecentHit = { kind: hit.kind, title: hit.title, href: hit.href, ref: hit.ref }
  const next = [entry, ...readRecent(storage).filter(r => r.href !== entry.href)].slice(
    0,
    RECENT_MAX
  )
  try {
    storage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Quota or privacy mode: the palette still works, it just forgets.
  }
  return next
}

// ---- Ranking, made visible ------------------------------------------------------------------------

const RERANK_SKIPPED: Record<NonNullable<SearchRanking['rerank']['reason']>, string> = {
  not_configured: 'no re-ranker',
  timeout: 're-ranker timed out',
  error: 're-ranker failed',
  too_few: 'too few results',
}

/** One line on how a result list was ordered: `Ranked by RRF over 2 lists · re-ranked by X`. */
export function rankingSummary(ranking: SearchRanking | undefined): string | null {
  if (!ranking) return null
  const lists = `Ranked by RRF over ${ranking.lists} list${ranking.lists === 1 ? '' : 's'}`
  const r = ranking.rerank
  if (r.applied) return `${lists} · re-ranked by ${r.model ?? 'a re-ranker'}`
  return `${lists} · not re-ranked (${RERANK_SKIPPED[r.reason ?? 'not_configured']})`
}

const DEGRADED_WORDS = { timeout: 'timed out', error: 'failed', invalid_response: 'answered badly' }

/** `Documents timed out; Guide failed` — for the notice when providers did not answer. */
export function degradedSummary(
  degraded: readonly { provider: string; reason: keyof typeof DEGRADED_WORDS }[],
  index: KindIndex
): string | null {
  if (degraded.length === 0) return null
  return degraded
    .map(d => `${index.providerLabel(d.provider)} ${DEGRADED_WORDS[d.reason]}`)
    .join('; ')
}

const fmt = (n: number, digits = 4) => n.toFixed(digits)

/** A small visible label for how a hit was found; `detail` is its numbers, for tooltips and readers. */
export interface ScoringSignal {
  label: 'name' | 'keyword' | 'meaning'
  detail: string
}

/** The re-ranker's move: `↑3`, `↓2` or `=`, with its score and the full sentence. */
export interface RerankMove {
  mark: string
  direction: 'up' | 'down' | 'same'
  score: string
  detail: string
}

export interface ScoringIndicatorsModel {
  signals: ScoringSignal[]
  fused: string
  move: RerankMove | null
}

const SIGNAL_ORDER: ScoringSignal['label'][] = ['name', 'keyword', 'meaning']

/**
 * The compact indicators a result row shows: which ways it was found (`name` — a list with no
 * halves; `keyword` / `meaning` — a hybrid list's two halves), the fused score, and the
 * re-ranker's move. Labels are visible; the numbers are in `detail`.
 */
export function scoringIndicators(
  scoring: SearchScoring | undefined,
  providerLabel: (id: string) => string = id => id,
  rerankModel?: string
): ScoringIndicatorsModel | null {
  if (!scoring) return null
  const details = new Map<ScoringSignal['label'], string[]>()
  const add = (label: ScoringSignal['label'], text: string) =>
    details.set(label, [...(details.get(label) ?? []), text])
  for (const s of scoring.sources) {
    const where = `${providerLabel(s.list)} #${s.rank}, +${fmt(s.contribution)}`
    if (s.lexical === undefined && s.dense === undefined) {
      add('name', where)
      continue
    }
    if (s.lexical != null) add('keyword', `${where} (keyword #${s.lexical})`)
    if (s.dense != null) add('meaning', `${where} (meaning #${s.dense})`)
  }
  const signals = SIGNAL_ORDER.filter(l => details.has(l)).map(label => ({
    label,
    detail: `Found by ${label}: ${(details.get(label) ?? []).join('; ')}`,
  }))
  let move: RerankMove | null = null
  if (scoring.rerank) {
    const r = scoring.rerank
    const delta = r.before - r.after
    const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'
    move = {
      mark: direction === 'up' ? `↑${delta}` : direction === 'down' ? `↓${-delta}` : '=',
      direction,
      score: fmt(r.score, 2),
      detail: `Re-ranked${rerankModel ? ` by ${rerankModel}` : ''}: score ${fmt(r.score, 3)}, from #${r.before} to #${r.after}`,
    }
  }
  return { signals, fused: fmt(scoring.fused), move }
}
