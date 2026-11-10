/**
 * The contents rail, grouped by part and then section in the config's reading order. `entries`
 * arrive ordered by the server — the same order prev/next follows.
 */
import type { GuideTocEntry, GuideTocResponse } from '@rocketflare/shared/plugins/guide/index'
import type { ReactNode } from 'react'

export interface GuideTocGroup {
  part: string
  label: string
  sections: { id: string; label: string; entries: GuideTocEntry[] }[]
}

/** The parts with at least one visible page, each with its non-empty sections. Pure. */
export function guideTocGroups(
  parts: GuideTocResponse['parts'],
  entries: readonly GuideTocEntry[]
): GuideTocGroup[] {
  return parts
    .map(part => ({
      part: part.id,
      label: part.label,
      sections: part.sections
        .map(sec => ({
          ...sec,
          entries: entries.filter(e => e.part === part.id && e.section === sec.id),
        }))
        .filter(sec => sec.entries.length > 0),
    }))
    .filter(g => g.sections.length > 0)
}

export function GuideToc({
  label,
  appName,
  parts,
  entries,
  selectedPath,
  onSelect,
  search,
}: {
  label: string
  appName: string
  parts: GuideTocResponse['parts']
  entries: GuideTocEntry[]
  selectedPath: string
  onSelect: (path: string) => void
  search: ReactNode
}) {
  const groups = guideTocGroups(parts, entries)
  return (
    <nav
      aria-label={`${label} contents`}
      className="hidden w-72 flex-none overflow-y-auto border-r border-base-300 bg-base-100 md:block"
    >
      <div className="sticky top-0 z-10 space-y-2 border-b border-base-300 bg-base-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="text-xs text-base-content/60">How to use {appName}</p>
        </div>
        {search}
      </div>
      <div className="px-2.5 py-3">
        {groups.map((g, gi) => (
          <section
            key={g.part}
            aria-labelledby={`guide-part-${g.part}`}
            className={gi > 0 ? 'mt-4 border-t border-base-300 pt-4' : undefined}
          >
            <h3
              id={`guide-part-${g.part}`}
              className="px-1.5 pb-2 text-xs font-semibold uppercase tracking-wide text-base-content/60"
            >
              {g.label}
            </h3>
            <div className="space-y-3">
              {g.sections.map(sec => (
                <div key={sec.id}>
                  <h4 className="px-1.5 pb-1 text-xs font-medium">{sec.label}</h4>
                  <ul className="ml-1.5 flex flex-col border-l border-base-300 pl-1.5">
                    {sec.entries.map(e => {
                      const active = e.path === selectedPath
                      return (
                        <li key={e.path}>
                          <button
                            type="button"
                            onClick={() => onSelect(e.path)}
                            aria-current={active ? 'page' : undefined}
                            title={e.summary}
                            className={`w-full rounded-md px-2 py-1 text-left text-[13px] leading-snug transition-colors ${
                              active
                                ? 'bg-base-200 font-semibold text-primary'
                                : 'hover:bg-base-200'
                            }`}
                          >
                            {e.title}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </nav>
  )
}
