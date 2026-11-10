/**
 * `/search/all`: every result of `GET /api/global-search` for a query, ranked, full width, with the
 * kind facets the palette has no room for in a LEFT RAIL (stacked above the results below `lg`):
 * each kind with how many of the top results it holds, counted from the same search WITHOUT the
 * kind filter, so a count does not vanish when its kind is ticked. Rows share the palette's kind
 * badges and snippet cleanup. The URL is the state (`?q&kinds`), so a search can be shared and the
 * palette's "Search everything" lands here.
 *
 * `role="status"` notices say when the answer is partial: a provider that did not answer
 * (`degraded`), or keyword-only matching (`semantic: unavailable`). A line above the results says
 * how they were ordered, and each row carries small indicators of how it was found.
 */
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { EmptyState, PageHeader, SectionPanel, SkeletonRows } from '@/plugins/api/ui'
import { KindBadge } from '../components/KindBadge'
import { ScoringIndicators } from '../components/ScoringIndicators'
import { useGlobalSearch, useSearchProviders } from '../hooks/useGlobalSearch'
import { degradedSummary, hitSnippet, kindIndex, rankingSummary } from '../searchModel'

const LIMIT = 50

function parseKinds(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(k => k.trim())
    .filter(k => /^[a-z][a-z0-9-]{0,39}$/.test(k))
}

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q')?.trim() ?? ''
  const kinds = parseKinds(params.get('kinds'))
  const [draft, setDraft] = useState(q)
  const providers = useSearchProviders()
  const index = useMemo(() => kindIndex(providers.data?.providers), [providers.data])
  const search = useGlobalSearch({ q, limit: LIMIT, ...(kinds.length ? { kinds } : {}) })
  // The counts come from the same search WITHOUT the kind filter (the same query, so the same
  // cache entry, when no kind is ticked).
  const unfiltered = useGlobalSearch({ q, limit: LIMIT })
  const counts = useMemo(() => {
    const by = new Map<string, number>()
    for (const hit of unfiltered.data?.items ?? []) by.set(hit.kind, (by.get(hit.kind) ?? 0) + 1)
    return by
  }, [unfiltered.data])

  // The box follows the URL (back/forward, the palette's hand-off).
  useEffect(() => setDraft(q), [q])

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    update({ q: draft.trim() || null })
  }
  const toggleKind = (kind: string) => {
    const next = kinds.includes(kind) ? kinds.filter(k => k !== kind) : [...kinds, kind]
    update({ kinds: next.length ? next.join(',') : null })
  }

  const hits = q ? (search.data?.items ?? []) : []
  const degraded = q ? degradedSummary(search.data?.degraded ?? [], index) : null

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Search everything"
        description="Pages, documents and whatever your installed plugins add — everything you can see."
      />
      <form onSubmit={submit} className="flex gap-2 mb-5" role="search">
        <label className="input input-bordered flex items-center gap-2 flex-1">
          <MagnifyingGlassIcon className="w-4 h-4 text-muted" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Search…"
            className="grow"
          />
        </label>
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] items-start">
        <aside
          aria-label="Filters"
          className="surface-panel p-0 overflow-hidden lg:sticky lg:top-4"
        >
          <fieldset aria-label="Kinds">
            <legend className="w-full px-4 py-2 text-xs font-semibold text-secondary bg-[var(--surface-inset)] border-b border-[var(--border-subtle)]">
              Kinds
            </legend>
            <div className="p-2 flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
              {index.kinds.map(info => {
                const on = kinds.includes(info.kind)
                const n = counts.get(info.kind) ?? 0
                return (
                  <button
                    type="button"
                    key={info.kind}
                    aria-pressed={on}
                    onClick={() => toggleKind(info.kind)}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left ${
                      on
                        ? 'bg-[var(--tone-info-surface)] shadow-[inset_3px_0_0_var(--color-accent)] font-medium'
                        : 'hover:bg-[var(--surface-hover)]'
                    }`}
                  >
                    <KindBadge info={info} />
                    <span className="flex-1">{info.label}</span>
                    {q && <span className="text-xs text-muted tabular-nums">{n}</span>}
                  </button>
                )
              })}
              {index.kinds.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted">
                  {providers.isPending ? 'Loading…' : 'Nothing to search yet.'}
                </p>
              )}
            </div>
          </fieldset>
        </aside>

        <div className="min-w-0">
          {degraded && (
            <div role="status" className="alert alert-warning mb-4 text-sm">
              Some sources did not answer in time, so these results are partial ({degraded}).
            </div>
          )}
          {q && search.data?.semantic === 'unavailable' && (
            <div role="status" className="alert alert-info mb-4 text-sm">
              Meaning-based matching is unavailable right now (no embeddings provider answered), so
              these are keyword and name matches only.
            </div>
          )}
          {q && search.data?.ranking && (
            <p className="text-xs text-muted mb-2" data-testid="ranking-summary">
              {rankingSummary(search.data.ranking)}
            </p>
          )}
          <SectionPanel flush>
            {!q ? (
              <EmptyState
                icon={MagnifyingGlassIcon}
                message="Search for anything"
                description="Tip: ⌘K (Ctrl K) opens search from any page."
              />
            ) : search.isPending ? (
              <div className="p-5">
                <SkeletonRows rows={5} />
              </div>
            ) : search.error ? (
              <EmptyState message={`Search failed: ${search.error.message}`} />
            ) : hits.length === 0 ? (
              <EmptyState message={`Nothing matches “${q}”`} />
            ) : (
              <ol aria-label="Results" className="divide-y divide-[var(--border-subtle)]">
                {hits.map(hit => {
                  const snippet = hitSnippet(hit, index)
                  return (
                    // `href` is unique: the search fuses on it.
                    <li key={hit.href} className="px-5 py-3 flex items-start gap-3">
                      <KindBadge info={index.get(hit.kind)} className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <Link to={hit.href} className="link link-accent link-hover font-medium">
                            {hit.title}
                          </Link>
                          <ScoringIndicators
                            scoring={hit.scoring}
                            providerLabel={index.providerLabel}
                            rerankModel={search.data?.ranking.rerank.model}
                            className="ml-auto self-start"
                          />
                        </div>
                        {snippet && (
                          <p className="text-sm text-secondary mt-1 line-clamp-2">{snippet}</p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </SectionPanel>
          {hits.length > 0 && (
            <p className="text-xs text-muted mt-2">
              {hits.length} result{hits.length === 1 ? '' : 's'}
              {hits.length === LIMIT ? ` (the first ${LIMIT})` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
