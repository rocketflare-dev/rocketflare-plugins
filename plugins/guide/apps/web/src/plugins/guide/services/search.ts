/**
 * Searching the guide — the kit's hybrid knowledge search over the guide's PLATFORM sources only
 * (`sources: []`, so no organisation document is ever mixed in), for the reader's audience.
 *
 * One function behind the reader's search box, `search_guide` and the `global-search` provider, so
 * the three can never disagree about what a member may find. A hit is re-checked against the
 * reader's own view of the bundle, so a stale index row for a page since removed (or one that moved
 * to admin) is dropped rather than linked.
 */
import { SEARCH_MAX_LIMIT } from '@rocketflare/shared/ai/embeddings'
import {
  type GuideSearchHit,
  guideHref,
  guideSourcesFor,
  parseGuideExternalId,
} from '@rocketflare/shared/plugins/guide/index'
import { type AccessScope, type PluginContext, searchKnowledge } from '@/plugins/api'
import { type GuideView, guideViewFor } from '../content'

export interface GuideSearchCtx extends Pick<PluginContext, 'db' | 'config' | 'env'> {
  scope: AccessScope
}

export interface GuidePassage extends GuideSearchHit {
  /** The whole passage, led by `Page › Section` — what the model reads. */
  text: string
  denseRank: number | null
  lexicalRank: number | null
}

const SNIPPET_CHARS = 220

/** The passage without its `Page › Section` lead, flattened to one line and trimmed. */
export function guideSnippet(text: string, title: string): string {
  const body = text.startsWith(title) ? text.slice(title.length) : text
  const flat = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : flat
}

export async function searchGuide(
  ctx: GuideSearchCtx,
  input: { query: string; limit: number; isAdmin: boolean; signal?: AbortSignal; view?: GuideView }
): Promise<{ passages: GuidePassage[]; semantic: 'used' | 'unavailable' }> {
  const view = input.view ?? guideViewFor(input.isAdmin)
  const { hits, semantic } = await searchKnowledge(ctx, {
    query: input.query,
    // A section can come back as several chunks; ask for more and keep one per section.
    // Over-fetch (several chunks per section collapse into one hit), within the kit's own cap.
    limit: Math.min(input.limit * 3, SEARCH_MAX_LIMIT),
    sources: [],
    platformSources: guideSourcesFor(input.isAdmin),
    signal: input.signal,
  })
  const seen = new Set<string>()
  const passages: GuidePassage[] = []
  for (const hit of hits) {
    if (!hit.platform || !hit.externalId) continue
    const { path, heading } = parseGuideExternalId(hit.externalId)
    const page = view.pages.get(path)
    if (!page) continue
    const key = `${path}#${heading ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    passages.push({
      path,
      heading,
      title: hit.title,
      pageTitle: page.frontmatter.title,
      snippet: guideSnippet(hit.text, hit.title),
      href: guideHref(path, heading),
      dense: hit.denseRank !== null,
      text: hit.text,
      denseRank: hit.denseRank,
      lexicalRank: hit.lexicalRank,
    })
    if (passages.length >= input.limit) break
  }
  return { passages, semantic }
}
