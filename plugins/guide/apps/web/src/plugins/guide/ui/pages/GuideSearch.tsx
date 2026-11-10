/**
 * The reader's own search box: semantic + keyword search over the guide (`GET /api/guide/search`),
 * one result per page section, each opening the reader at its heading. Debounced; Escape clears.
 */
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { guideSearchQuery } from '../lib/queries'

const DEBOUNCE_MS = 250

export function GuideSearch({ onOpen }: { onOpen: (href: string) => void }) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const listId = useId()

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [input])

  const search = useQuery(guideSearchQuery(query))
  const hits = query ? (search.data?.hits ?? []) : []

  const open = (href: string) => {
    setInput('')
    setQuery('')
    onOpen(href)
  }

  return (
    <div className="relative">
      <label className="input input-bordered input-sm flex w-full items-center gap-2">
        <MagnifyingGlassIcon className="h-4 w-4 opacity-60" />
        <input
          type="search"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') setInput('')
          }}
          placeholder="Search the guide"
          aria-label="Search the guide"
          aria-controls={listId}
          className="grow"
        />
      </label>
      {query && (
        <div
          id={listId}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-lg border border-base-300 bg-base-100 shadow-lg"
        >
          {search.isLoading ? (
            <p className="px-3 py-2 text-xs text-base-content/60">Searching…</p>
          ) : search.isError ? (
            <p className="px-3 py-2 text-xs text-error">Search failed.</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-base-content/60">Nothing in the guide matches.</p>
          ) : (
            <ul aria-label="Search results">
              {hits.map(hit => (
                <li key={hit.href}>
                  <button
                    type="button"
                    onClick={() => open(hit.href)}
                    className="block w-full border-b border-base-200 px-3 py-2 text-left last:border-b-0 hover:bg-base-200"
                  >
                    <span className="block text-[13px] font-medium leading-snug">{hit.title}</span>
                    {hit.snippet && (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-base-content/60">
                        {hit.snippet}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {search.data?.semantic === 'unavailable' && hits.length > 0 && (
            <p className="border-t border-base-200 px-3 py-1.5 text-[11px] text-base-content/60">
              Keyword matches only — semantic search is not configured.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
