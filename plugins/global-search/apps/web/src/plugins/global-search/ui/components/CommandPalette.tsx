/**
 * The ⌘K palette: one box that jumps to anything the reader may see, through
 * `GET /api/global-search` (debounced). Results are grouped by kind — groups, labels, badges and
 * tones from the registered providers (`GET /api/global-search/providers`) — each row with its
 * kind badge and a cleaned snippet; arrows move, Enter opens, Escape closes. With an empty box it
 * offers the items opened from here before (localStorage `global-search:recent`, newest first).
 * The last row hands off to `/search/all`.
 *
 * Hand-rolled on a `<dialog>` (the kit `Modal`'s pattern: `showModal()` makes the page inert where
 * the browser supports it) plus an explicit Tab trap, so focus never leaves the box. The input is
 * an ARIA combobox over a listbox; the active option is `aria-activedescendant`, so focus stays in
 * the input while the arrows move. Lazy: the trigger loads it on first open.
 */
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import {
  GLOBAL_SEARCH_PAGE_PATH,
  type GlobalSearchHit,
} from '@rocketflare/shared/plugins/global-search/index'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useDebounce } from '../hooks/useDebounce'
import { useGlobalSearch, useSearchProviders } from '../hooks/useGlobalSearch'
import {
  balanceHits,
  degradedSummary,
  groupHits,
  hitSnippet,
  type KindInfo,
  kindIndex,
  pushRecent,
  type RecentHit,
  rankingSummary,
  readRecent,
} from '../searchModel'
import { KindBadge } from './KindBadge'
import { ScoringIndicators } from './ScoringIndicators'

export const PALETTE_DEBOUNCE_MS = 200
/** Rows the palette shows, from a longer ranked list balanced across kinds (`balanceHits`). */
const PALETTE_LIMIT = 20
const PALETTE_FETCH = 50
const PALETTE_PER_KIND = 5

interface Option {
  id: string
  title: string
  detail: string | null
  kind?: KindInfo
  href: string
  hit?: GlobalSearchHit | RecentHit
}

interface Section {
  key: string
  label: string | null
  options: Option[]
}

export const searchAllHref = (q: string) =>
  `${GLOBAL_SEARCH_PAGE_PATH}?${new URLSearchParams({ q })}`

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const baseId = useId()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [recent] = useState(() => readRecent())
  const debounced = useDebounce(q.trim(), PALETTE_DEBOUNCE_MS)
  const providers = useSearchProviders()
  const index = useMemo(() => kindIndex(providers.data?.providers), [providers.data])
  const search = useGlobalSearch({ q: debounced, limit: PALETTE_FETCH })
  const typing = q.trim().length > 0
  // Balanced, so a broad query one provider answers twenty times over still shows the others;
  // `/search/all` keeps the full ranked list.
  const hits = useMemo(
    () =>
      typing
        ? balanceHits(search.data?.items ?? [], { perKind: PALETTE_PER_KIND, total: PALETTE_LIMIT })
        : [],
    [typing, search.data]
  )
  const ranking = typing ? search.data?.ranking : undefined

  const sections = useMemo<Section[]>(() => {
    if (!typing) {
      return recent.length === 0
        ? []
        : [
            {
              key: 'recent',
              label: 'Recent',
              options: recent.map((r, i) => ({
                id: `${baseId}-recent-${i}`,
                title: r.title,
                detail: null,
                kind: index.get(r.kind),
                href: r.href,
                hit: r,
              })),
            },
          ]
    }
    const groups: Section[] = groupHits(hits, index).map(g => ({
      key: g.kind,
      label: g.label,
      options: g.hits.map((h, i) => ({
        id: `${baseId}-${g.kind}-${i}`,
        title: h.title,
        detail: hitSnippet(h, index),
        kind: index.get(h.kind),
        href: h.href,
        hit: h,
      })),
    }))
    groups.push({
      key: 'all',
      label: null,
      options: [
        {
          id: `${baseId}-all`,
          title: `Search everything for “${q.trim()}”`,
          detail: 'Every result, with filters',
          href: searchAllHref(q.trim()),
        },
      ],
    })
    return groups
  }, [typing, recent, hits, baseId, q, index])

  const options = useMemo(() => sections.flatMap(s => s.options), [sections])
  const current = options[Math.min(active, options.length - 1)]

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
    inputRef.current?.focus()
  }, [])

  const currentId = current?.id
  useEffect(() => {
    if (!currentId) return
    const el = document.getElementById(currentId)
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [currentId])

  const choose = (option: Option) => {
    if (option.hit) pushRecent(option.hit)
    onClose()
    navigate(option.href)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Tab') {
      // The trap: the input is the only stop, so Tab and Shift-Tab stay inside.
      e.preventDefault()
      inputRef.current?.focus()
      return
    }
    if (options.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(i => (i + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => (i - 1 + options.length) % options.length)
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault()
      setActive(options.length - 1)
    } else if (e.key === 'Enter' && current) {
      e.preventDefault()
      choose(current)
    }
  }

  const listboxId = `${baseId}-listbox`
  const degraded = typing ? degradedSummary(search.data?.degraded ?? [], index) : null
  const status = !typing
    ? recent.length === 0
      ? 'Type to search everything you can see.'
      : `${recent.length} recent`
    : search.isFetching && !search.data
      ? 'Searching…'
      : search.error
        ? `Search failed: ${search.error.message}`
        : `${hits.length} result${hits.length === 1 ? '' : 's'}`

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-top"
      aria-label="Search"
      aria-modal="true"
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the keys are the combobox's, caught here so the trap also covers the list */}
      <div
        className="modal-box popover-surface p-0 mt-[10vh] mx-auto w-[92vw] max-w-[960px] flex flex-col max-h-[76vh]"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-4 border-b border-[var(--border-subtle)]">
          <MagnifyingGlassIcon className="w-5 h-5 text-muted shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search everything"
            aria-expanded={options.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={current?.id}
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={e => {
              setQ(e.target.value)
              // A new query starts at the first option.
              setActive(0)
            }}
            placeholder="Search pages, documents and more…"
            className="flex-1 bg-transparent py-3.5 text-sm outline-none"
          />
          <kbd className="kbd kbd-sm">Esc</kbd>
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label="Results"
          className="flex-1 min-h-0 overflow-y-auto pb-2"
        >
          {sections.map(section => {
            const labelId = `${baseId}-${section.key}-label`
            const rows = section.options.map((option, rowIndex) => {
              const selected = option.id === current?.id
              return (
                <div
                  key={option.id}
                  id={option.id}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onMouseMove={() => setActive(options.indexOf(option))}
                  onClick={() => choose(option)}
                  className={`px-5 py-2.5 cursor-pointer flex items-start gap-3 ${
                    rowIndex > 0 ? 'border-t border-[var(--border-subtle)]' : ''
                  } ${
                    selected
                      ? 'bg-[var(--tone-info-surface)] shadow-[inset_3px_0_0_var(--color-accent)]'
                      : ''
                  }`}
                >
                  {option.kind && <KindBadge info={option.kind} className="mt-0.5 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <div className="text-sm font-medium truncate min-w-0 flex-1">
                        {option.title}
                      </div>
                      {option.hit && 'scoring' in option.hit && (
                        <ScoringIndicators
                          scoring={option.hit.scoring}
                          providerLabel={index.providerLabel}
                          rerankModel={ranking?.rerank.model}
                          compact
                        />
                      )}
                    </div>
                    {option.detail && (
                      <div className="text-xs truncate mt-0.5 text-muted">{option.detail}</div>
                    )}
                  </div>
                </div>
              )
            })
            if (!section.label) {
              return (
                <div key={section.key} className="border-t border-[var(--border-default)]">
                  {rows}
                </div>
              )
            }
            return (
              <div key={section.key} role="group" aria-labelledby={labelId}>
                <div className="sticky top-0 z-[1] flex items-center gap-2 px-5 py-1.5 text-xs font-semibold text-secondary bg-[var(--surface-inset)] border-y border-[var(--border-subtle)]">
                  <span id={labelId}>{section.label}</span>
                  <span className="font-normal text-muted">{section.options.length}</span>
                </div>
                {rows}
              </div>
            )
          })}
        </div>
        <div
          className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border-subtle)] text-xs text-muted"
          aria-live="polite"
        >
          <span className="flex-1 truncate">{status}</span>
          {degraded && (
            <span className="badge badge-warning badge-xs" title={degraded}>
              Partial results
            </span>
          )}
          {ranking?.rerank.applied && (
            <span
              className="badge badge-ghost badge-xs"
              title={rankingSummary(ranking) ?? undefined}
            >
              Re-ranked
            </span>
          )}
          {typing && search.data?.semantic === 'unavailable' && (
            <span
              className="badge badge-ghost badge-xs"
              title="No embeddings provider answered: names and keywords still match"
            >
              Keyword matches only
            </span>
          )}
          <span className="hidden sm:inline">
            <kbd className="kbd kbd-xs">↑</kbd> <kbd className="kbd kbd-xs">↓</kbd> to move,{' '}
            <kbd className="kbd kbd-xs">Enter</kbd> to open
          </span>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" aria-label="Close search" tabIndex={-1} onClick={onClose} />
      </form>
    </dialog>
  )
}
