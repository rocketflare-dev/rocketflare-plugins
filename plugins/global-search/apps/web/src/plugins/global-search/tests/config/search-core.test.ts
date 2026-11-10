/**
 * The search core without a database: RRF fusion (k = 60, per-hit weights, the dense-only
 * discount, the kind that names a shared href), the fan-out (parallel, per-provider budget,
 * `degraded` for a timeout, a throw and an invalid answer, kinds narrowing), guard filtering,
 * the re-ranker's failure modes, the registry's validation, and the name matching the entity
 * providers use.
 */
// Enter through the plugin barrel first: this file's subjects import `@/plugins/api` at runtime,
// and entering THERE first evaluates the barrel mid-way (`plugins/CLAUDE.md`, module order).
import '@/plugins/api/peers'
import type { SearchProviderHit } from '@rocketflare/shared/plugins/global-search/index'
import { describe, expect, it } from 'vitest'
import { agentsProvider } from '../../providers/agents'
import { chatsProvider } from '../../providers/chats'
import { documentsProvider } from '../../providers/documents'
import { escapeLike, textRank } from '../../providers/match'
import { peopleProvider } from '../../providers/people'
import { buildRegistry, InvalidSearchProviderError } from '../../services/registry'
import type { RerankClient } from '../../services/rerank'
import {
  DENSE_ONLY_WEIGHT,
  fanOut,
  fuse,
  globalSearch,
  rerankText,
  usableProviders,
} from '../../services/search'
import type { SearchProvider, SearchProviderCtx } from '../../types'

const hit = (href: string, extra: Partial<SearchProviderHit> = {}): SearchProviderHit => ({
  kind: 'thing',
  title: href,
  snippet: null,
  ref: href,
  href,
  ...extra,
})

function ctx(over: Partial<SearchProviderCtx> = {}): SearchProviderCtx {
  return {
    db: undefined as never,
    config: undefined as never,
    env: undefined as never,
    scope: undefined as never,
    tenantId: 't1',
    userId: 'u1',
    isAdmin: false,
    can: () => true,
    ...over,
  }
}

function provider(
  id: string,
  search: SearchProvider['search'],
  over: Partial<SearchProvider> = {}
): SearchProvider {
  return {
    id,
    label: id,
    kinds: [{ kind: id.split(':')[1] ?? 'thing', label: 'Things', order: 10 }],
    search,
    ...over,
  }
}

describe('fuse (RRF, k = 60)', () => {
  it('scores each list 1/(60+rank), sums a href found twice, and records every vote', () => {
    const out = fuse([
      { list: 'a:x', hits: [hit('/1'), hit('/2')] },
      { list: 'b:y', hits: [hit('/2'), hit('/3')] },
    ])
    expect(out.map(h => h.href)).toEqual(['/2', '/1', '/3'])
    const two = out[0]
    expect(two?.score).toBeCloseTo(1 / 62 + 1 / 61)
    expect(two?.scoring.sources.map(s => [s.list, s.rank])).toEqual([
      ['a:x', 2],
      ['b:y', 1],
    ])
    expect(two?.provider).toBe('a:x')
    expect(out[1]?.score).toBeCloseTo(1 / 61)
  })

  it('weights a hit’s contribution, and a dense-only hit counts half', () => {
    const out = fuse([
      {
        list: 'docs',
        hits: [
          hit('/near', { weight: DENSE_ONLY_WEIGHT, halves: { lexical: null, dense: 1 } }),
          hit('/exact', { halves: { lexical: 1, dense: 2 } }),
        ],
      },
    ])
    expect(DENSE_ONLY_WEIGHT).toBe(0.5)
    // The exact keyword match outranks the nearest neighbour above it.
    expect(out.map(h => h.href)).toEqual(['/exact', '/near'])
    expect(out[1]?.scoring.sources[0]).toMatchObject({ weight: 0.5, lexical: null, dense: 1 })
  })

  it('names a shared href by the kind with the lower order, and keeps the first snippet', () => {
    const order = (k: string) => ({ page: 0, document: 50 })[k] ?? 99
    const out = fuse(
      [
        { list: 'docs', hits: [hit('/x', { kind: 'document', snippet: 'from docs' })] },
        { list: 'nav', hits: [hit('/x', { kind: 'page' })] },
      ],
      order
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'page', snippet: 'from docs' })
  })

  it('breaks a tie on href, so the order never depends on timing', () => {
    const out = fuse([
      { list: 'a', hits: [hit('/b')] },
      { list: 'b', hits: [hit('/a')] },
    ])
    expect(out.map(h => h.href)).toEqual(['/a', '/b'])
  })
})

describe('fanOut', () => {
  it('calls providers in parallel, each with only the kinds wanted from it', async () => {
    const seen: Record<string, string[]> = {}
    const started: number[] = []
    const slowish = (id: string) =>
      provider(
        id,
        async (_ctx, input) => {
          started.push(Date.now())
          seen[id] = [...input.kinds]
          await new Promise(r => setTimeout(r, 50))
          return [hit(`/${id}`, { kind: id.split(':')[1] })]
        },
        { kinds: [{ kind: id.split(':')[1] as string, label: 'x', order: 1 }] }
      )
    const t0 = Date.now()
    const out = await fanOut([slowish('a:one'), slowish('a:two'), slowish('a:three')], ctx(), {
      q: 'q',
      pool: 20,
      wanted: new Set(['one', 'two']),
    })
    expect(Object.keys(seen).sort()).toEqual(['a:one', 'a:two'])
    expect(seen['a:one']).toEqual(['one'])
    expect(out.lists.map(l => l.list)).toEqual(['a:one', 'a:two'])
    // Parallel: two 50 ms providers well under 100 ms of wall time.
    expect(Date.now() - t0).toBeLessThan(95)
  })

  it('reports a timeout, a throw and an invalid answer in degraded, in registration order', async () => {
    const out = await fanOut(
      [
        provider('a:slow', () => new Promise(() => {})),
        provider('a:throws', async () => {
          throw new Error('boom')
        }),
        provider('a:bad', async () => [{ kind: 'bad', title: '', href: 'nope' }] as never),
        provider('a:ok', async () => [hit('/ok', { kind: 'ok' })]),
      ],
      ctx(),
      { q: 'q', pool: 20, wanted: null },
      { timeoutMs: 30 }
    )
    expect(out.degraded).toEqual([
      { provider: 'a:slow', reason: 'timeout' },
      { provider: 'a:throws', reason: 'error' },
      { provider: 'a:bad', reason: 'invalid_response' },
    ])
    expect(out.lists).toEqual([{ list: 'a:ok', hits: [hit('/ok', { kind: 'ok' })] }])
  })

  it('aborts the signal at the budget, and drops hits of kinds it was not asked for', async () => {
    let aborted = false
    const out = await fanOut(
      [
        provider('a:listens', (_ctx, input) => {
          input.signal.addEventListener('abort', () => {
            aborted = true
          })
          return new Promise(() => {})
        }),
        provider('a:mixed', async () => [
          hit('/m1', { kind: 'mixed' }),
          hit('/m2', { kind: 'other' }),
        ]),
      ],
      ctx(),
      { q: 'q', pool: 20, wanted: null },
      { timeoutMs: 20 }
    )
    expect(aborted).toBe(true)
    expect(out.lists[0]?.hits.map(h => h.href)).toEqual(['/m1'])
  })

  it('reports semantic as a provider says, skipped when none says', async () => {
    const say = (state: 'used' | 'unavailable') =>
      provider(`a:${state}`, async (_c, input) => {
        input.reportSemantic?.(state)
        return []
      })
    const run = (ps: SearchProvider[]) =>
      fanOut(ps, ctx(), { q: 'q', pool: 5, wanted: null }).then(r => r.semantic)
    expect(await run([say('used')])).toBe('used')
    expect(await run([say('used'), say('unavailable')])).toBe('unavailable')
    expect(await run([provider('a:quiet', async () => [])])).toBe('skipped')
  })
})

describe('usableProviders', () => {
  it('drops a provider whose guard the reader fails', () => {
    const open = provider('a:open', async () => [])
    const guarded = provider('a:guarded', async () => [], {
      guard: { action: 'read', subject: 'Trace' },
    })
    expect(usableProviders([open, guarded], () => false).map(p => p.id)).toEqual(['a:open'])
    expect(
      usableProviders([open, guarded], (a, s) => a === 'read' && s === 'Trace').map(p => p.id)
    ).toEqual(['a:open', 'a:guarded'])
  })
})

describe('globalSearch and the re-ranker', () => {
  const two = provider('a:two', async () => [
    hit('/1', { kind: 'two', title: 'First' }),
    hit('/2', { kind: 'two', title: 'Second' }),
  ])

  it('keeps the fused order when the re-ranker cannot even be resolved (a key that will not open)', async () => {
    const out = await globalSearch(
      [two],
      ctx(),
      { q: 'q', limit: 10 },
      {
        reranker: async () => {
          throw new Error('encryption_key_missing')
        },
      }
    )
    expect(out.items.map(h => h.href)).toEqual(['/1', '/2'])
    expect(out.ranking.rerank).toEqual({ applied: false, reason: 'error' })
  })

  it('re-ranks the head and records each move', async () => {
    const client: RerankClient = {
      model: 'm',
      rerank: async () => ({
        results: [
          { index: 1, score: 0.9 },
          { index: 0, score: 0.1 },
        ],
        inputTokens: 0,
      }),
    }
    const out = await globalSearch(
      [two],
      ctx(),
      { q: 'q', limit: 10 },
      { reranker: async () => client }
    )
    expect(out.items.map(h => h.href)).toEqual(['/2', '/1'])
    expect(out.items[0]?.scoring?.rerank).toEqual({ score: 0.9, before: 2, after: 1 })
    expect(out.ranking).toMatchObject({
      lists: 1,
      rerank: { applied: true, model: 'm', candidates: 2 },
    })
  })

  it('gives the re-ranker the title and the cleaned snippet a person reads', () => {
    expect(rerankText({ title: 'Orders', snippet: '**Orders** are *shipped* daily.' })).toBe(
      'Orders\nOrders are *shipped* daily.'
    )
    expect(rerankText({ title: 'Bare', snippet: null })).toBe('Bare')
  })

  it('caps the result at limit', async () => {
    const many = provider('a:many', async () =>
      Array.from({ length: 30 }, (_, i) => hit(`/${i}`, { kind: 'many' }))
    )
    const out = await globalSearch([many], ctx(), { q: 'q', limit: 5 })
    expect(out.items).toHaveLength(5)
  })
})

describe('buildRegistry', () => {
  const ok = provider('acme:tickets', async () => [])

  it('accepts a valid registration', () => {
    expect(buildRegistry([ok], ['acme']).map(p => p.id)).toEqual(['acme:tickets'])
  })

  it('refuses an invalid one with a message naming who contributed and what is wrong', () => {
    const attempt = () =>
      buildRegistry([ok, { id: 'acme:bad', label: 'Bad', kinds: [], search: 'nope' }], ['acme'])
    expect(attempt).toThrow(InvalidSearchProviderError)
    expect(attempt).toThrow(
      /'global-search\.providers' \(contributed by acme\): entry 1 \('acme:bad'\) — kinds: .*search: search must be a function/
    )
  })

  it('refuses an id that is not <plugin>:<list>, a foreign namespace, a duplicate id and a shared kind', () => {
    expect(() => buildRegistry([{ ...ok, id: 'tickets' }], ['acme'])).toThrow(/<plugin id>:<list>/)
    expect(() => buildRegistry([{ ...ok, id: 'guide:pages' }], ['acme'])).toThrow(
      /namespaced 'guide'/
    )
    expect(() => buildRegistry([ok, ok], ['acme'])).toThrow(/registered twice/)
    expect(() => buildRegistry([ok, { ...ok, id: 'acme:other' }], ['acme'])).toThrow(
      /kind 'tickets' is declared by both 'acme:tickets' and 'acme:other'/
    )
  })

  it('refuses a kind that is not a slug and a tone outside the set', () => {
    expect(() =>
      buildRegistry([{ ...ok, kinds: [{ kind: 'Big Kind', label: 'x', order: 1 }] }], ['acme'])
    ).toThrow(/kinds\.0\.kind/)
    expect(() =>
      buildRegistry(
        [{ ...ok, kinds: [{ kind: 'k', label: 'x', order: 1, tone: 'red' }] }],
        ['acme']
      )
    ).toThrow(/kinds\.0\.tone/)
  })

  it('registers the built-ins cleanly', () => {
    expect(
      buildRegistry(
        [peopleProvider, agentsProvider, chatsProvider, documentsProvider],
        ['global-search']
      ).map(p => p.id)
    ).toEqual([
      'global-search:people',
      'global-search:agents',
      'global-search:chats',
      'global-search:documents',
    ])
    expect(documentsProvider.guard).toEqual({ action: 'read', subject: 'Document' })
  })
})

describe('name matching', () => {
  it('escapes the LIKE wildcards and the escape itself', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x')
  })

  it('ranks exact over prefix over word start over anywhere', () => {
    expect(textRank('Research topic', 'research topic')).toBe(0)
    expect(textRank('Research topic', 'resea')).toBe(1)
    expect(textRank('Research topic', 'top')).toBe(2)
    expect(textRank('Research topic', 'opi')).toBe(3)
    expect(textRank('Research topic', 'zzz')).toBe(4)
  })
})
