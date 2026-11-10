/**
 * `global-search:documents` — the organisation's own knowledge-base documents, through the kit's
 * hybrid `searchKnowledge` (keyword + meaning, RRF), as the reader's `AccessScope` may read them.
 * Tenant documents ONLY: no `platformSources`, so no platform (every-tenant) document ever appears.
 * Guarded by `read Document`, the guard on the kit's own `/documents` and `/search`.
 *
 * One hit per document — its best passage — deep-linked the way the kit's `/search` page links a
 * passage (`documentPath(id, { offset, q })`: the viewer scrolls to the offset and highlights the
 * query). A passage only the dense half found counts `DENSE_ONLY_WEIGHT` in the fusion.
 *
 * `searchKnowledge` falls back to keyword search when the tenant has no embeddings provider and
 * says so (`semantic: 'unavailable'`), which this provider reports. An embeddings OUTAGE throws,
 * and the fan-out reports the provider as `error`.
 */
import { documentPath, SEARCH_MAX_LIMIT } from '@rocketflare/shared/ai/embeddings'
import { DENSE_ONLY_WEIGHT } from '@rocketflare/shared/plugins/global-search/index'
import { searchKnowledge } from '@/plugins/api'
import type { SearchProvider } from '../types'

export const DOCUMENTS_PROVIDER_ID = 'global-search:documents'
export const DOCUMENT_KIND = 'document'

const SNIPPET_MAX = 240

function snippet(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat
}

export const documentsProvider: SearchProvider = {
  id: DOCUMENTS_PROVIDER_ID,
  label: 'Knowledge base',
  kinds: [{ kind: DOCUMENT_KIND, label: 'Documents', badge: 'document', tone: 'info', order: 50 }],
  guard: { action: 'read', subject: 'Document' },
  async search(ctx, input) {
    const { hits, semantic } = await searchKnowledge(ctx, {
      query: input.q,
      limit: Math.min(input.pool, SEARCH_MAX_LIMIT),
      signal: input.signal,
    })
    input.reportSemantic?.(semantic)
    const best = new Map<string, (typeof hits)[number]>()
    for (const hit of hits) {
      if (hit.platform) continue
      if (!best.has(hit.documentId)) best.set(hit.documentId, hit)
    }
    return [...best.values()].map(hit => ({
      kind: DOCUMENT_KIND,
      title: hit.title,
      snippet: snippet(hit.text),
      ref: hit.documentId,
      href: documentPath(hit.documentId, { offset: hit.charOffset, q: input.q }),
      ...(hit.lexicalRank === null ? { weight: DENSE_ONLY_WEIGHT } : {}),
      halves: { lexical: hit.lexicalRank, dense: hit.denseRank },
    }))
  },
}
