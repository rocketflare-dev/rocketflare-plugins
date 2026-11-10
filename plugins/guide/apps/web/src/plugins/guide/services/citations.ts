/**
 * The answer's citations. The model ends an answer with a plain-text block, one line per source,
 * `|`-separated `field=value` pairs, `-` for "none":
 *
 *     CITATIONS:
 *     page=start/inviting-people.md | heading=do-it | note=how to send an invitation
 *
 * Split off, parsed, resolved against the asker's OWN view of the guide (so a page they may not
 * read comes back `valid: false`) and de-duplicated. Pure.
 */
import type { GuideCitation } from '@rocketflare/shared/plugins/guide/index'
import type { GuideView } from '../content'

export interface RawGuideCitation {
  page: string | null
  heading: string | null
  note: string | null
}

const CITATIONS_HEADER = /\n?CITATIONS:\s*\n/i
const FIELD = /^\s*(page|heading|note)\s*=\s*(.*?)\s*$/

/** Split the trailing `CITATIONS:` block off an answer. Lines without a `page` are dropped. */
export function splitGuideCitations(text: string): {
  answer: string
  citations: RawGuideCitation[]
} {
  const idx = text.search(CITATIONS_HEADER)
  if (idx === -1) return { answer: text.trim(), citations: [] }
  const answer = text.slice(0, idx).trim()
  const block = text.slice(idx).replace(CITATIONS_HEADER, '')
  const dash = (v: string | undefined) => (!v || v === '-' ? null : v)
  const citations: RawGuideCitation[] = []
  for (const line of block.split('\n')) {
    if (!line.trim()) continue
    const fields: Partial<Record<keyof RawGuideCitation, string>> = {}
    for (const part of line.split('|')) {
      const m = FIELD.exec(part)
      if (m) fields[m[1] as keyof RawGuideCitation] = m[2]
    }
    if (!dash(fields.page)) continue
    citations.push({
      page: dash(fields.page),
      heading: dash(fields.heading),
      note: dash(fields.note),
    })
  }
  return { answer, citations }
}

/** Resolve one citation against the reader's view: a real page they can open, at a real heading. */
export function resolveGuideCitation(c: RawGuideCitation, view: GuideView): GuideCitation {
  const page = c.page ? (view.pages.get(c.page) ?? null) : null
  const heading = page && c.heading && page.outline.some(o => o.id === c.heading) ? c.heading : null
  return {
    page: c.page,
    heading,
    note: c.note,
    title: page?.frontmatter.title ?? c.note ?? c.page ?? 'Source',
    valid: Boolean(page),
  }
}

/**
 * One entry per page + heading. The first occurrence wins unless a later duplicate resolves where
 * it did not.
 */
export function dedupeGuideCitations(citations: GuideCitation[]): GuideCitation[] {
  const byKey = new Map<string, GuideCitation>()
  for (const c of citations) {
    const key = `${c.page ?? ''}#${c.heading ?? ''}`
    const existing = byKey.get(key)
    if (!existing || (!existing.valid && c.valid)) byKey.set(key, c)
  }
  return [...byKey.values()]
}

/** How many searched sections stand in for citations when the model wrote none. */
export const FALLBACK_CITATIONS = 3

/**
 * The citations a model that wrote no `CITATIONS:` block gets instead: the top sections its own
 * `search_guide` calls returned, in the order it read them, one per page. Smaller models often
 * skip the block; the reader still deserves to see where the answer came from. Each is marked
 * with the note "searched", never presented as something the model claimed.
 */
export function searchedGuideCitations(
  passages: readonly { path: string; heading: string | null }[],
  view: GuideView
): GuideCitation[] {
  const seen = new Set<string>()
  const out: GuideCitation[] = []
  for (const p of passages) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    out.push(resolveGuideCitation({ page: p.path, heading: p.heading, note: 'searched' }, view))
    if (out.length >= FALLBACK_CITATIONS) break
  }
  return out.filter(c => c.valid)
}
