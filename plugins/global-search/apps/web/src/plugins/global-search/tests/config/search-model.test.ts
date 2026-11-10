/**
 * The pure half of search (`ui/searchModel.ts` and the shared `search-text`): the kind index
 * built from the providers' metadata, grouping by kind order, snippet cleanup with a provider's
 * own field labels, the palette's balancing, the ranking in words, and the recent list — newest
 * first, deduped, capped, and never trusting a stored entry that is not an in-app path.
 */
import type {
  GlobalSearchHit,
  SearchProviderInfo,
} from '@rocketflare/shared/plugins/global-search/index'
import { describe, expect, it } from 'vitest'
import {
  balanceHits,
  cleanSnippet,
  degradedSummary,
  groupHits,
  hitSnippet,
  kindIndex,
  pushRecent,
  RECENT_KEY,
  RECENT_MAX,
  rankingSummary,
  readRecent,
  scoringIndicators,
} from '../../ui/searchModel'

const PROVIDERS: SearchProviderInfo[] = [
  {
    id: 'acme:pages',
    label: 'Pages',
    kinds: [{ kind: 'page', label: 'Pages', badge: 'page', tone: 'accent', order: 0 }],
  },
  {
    id: 'global-search:documents',
    label: 'Knowledge base',
    kinds: [{ kind: 'document', label: 'Documents', tone: 'info', order: 50 }],
  },
  {
    id: 'acme:questions',
    label: 'Questions',
    kinds: [{ kind: 'question', label: 'Open questions', badge: 'question', order: 20 }],
    snippetLabels: {
      fields: ['Item', 'Question', 'About'],
      noise: ['Item', 'About'],
      bare: ['Question'],
    },
  },
]
const index = kindIndex(PROVIDERS)

const hit = (kind: string, title: string): GlobalSearchHit => ({
  kind,
  title,
  snippet: null,
  ref: title,
  href: `/x/${title}`,
  provider: 'p',
  score: 0,
})

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

describe('kindIndex', () => {
  it('orders kinds by their order and fills the badge and tone defaults', () => {
    expect(index.kinds.map(k => k.kind)).toEqual(['page', 'question', 'document'])
    expect(index.get('document')).toMatchObject({ badge: 'document', tone: 'info' })
    expect(index.get('question')).toMatchObject({ tone: 'neutral', provider: 'acme:questions' })
    expect(index.get('unknown')).toMatchObject({ label: 'unknown', tone: 'neutral' })
    expect(index.providerLabel('global-search:documents')).toBe('Knowledge base')
  })
})

describe('groupHits', () => {
  it('orders groups by kind order and keeps rank order inside each', () => {
    const groups = groupHits(
      [hit('document', 'd1'), hit('question', 'q1'), hit('page', 'p1'), hit('question', 'q2')],
      index
    )
    expect(groups.map(g => [g.label, g.hits.map(h => h.title)])).toEqual([
      ['Pages', ['p1']],
      ['Open questions', ['q1', 'q2']],
      ['Documents', ['d1']],
    ])
  })
})

describe('cleanSnippet', () => {
  it('uses a provider’s labels: noise dropped, a bare field shown as its text', () => {
    const snippet =
      '# Cancelling never checks the refund window Item: question:GQ-0002 Question: Can an order be cancelled after 30 days? About: severity high'
    expect(
      hitSnippet(
        { kind: 'question', title: 'Cancelling never checks the refund window', snippet },
        index
      )
    ).toBe('Can an order be cancelled after 30 days?')
  })

  it('keeps other labelled fields as `Label: value`', () => {
    expect(
      cleanSnippet('Endpoint: POST /orders Auth: bearer', 'x', {
        fields: ['Endpoint', 'Auth'],
      })
    ).toBe('Endpoint: POST /orders · Auth: bearer')
  })

  it('treats labels literally, never as patterns', () => {
    expect(cleanSnippet('a (b) c: d', '', { fields: ['(b) c'] })).toBe('a · (b) c: d')
    expect(cleanSnippet('x .* y: z', '', { fields: ['.*'] })).toBe('x .* y: z')
  })

  it('reads markdown as text: no breadcrumb echo, anchor comment, heading marks or link urls', () => {
    expect(
      cleanSnippet(
        'API › API › POST /orders POST /orders <!-- id: x --> Creates an order from the `total`. See [the guide](/guide?path=a.md).',
        'POST /orders'
      )
    ).toBe('Creates an order from the total. See the guide.')
  })

  it('drops a title a document’s opening passage repeats', () => {
    expect(
      cleanSnippet(
        'Orders — questions for the rebuild Orders — questions for the rebuild We are rebuilding this system.',
        'Orders — questions for the rebuild'
      )
    ).toBe('We are rebuilding this system.')
  })

  it('turns a markdown table into cells, not pipes and dashes', () => {
    expect(
      cleanSnippet('| Code | Meaning | |---|---| | 0 | success | | 1 | an error |', 'CLI')
    ).toBe('Code · Meaning · 0 · success · 1 · an error')
  })

  it('leaves plain prose alone except emphasis marks and tags', () => {
    expect(cleanSnippet('The **proposal** treats each file as a unit.', 'x')).toBe(
      'The proposal treats each file as a unit.'
    )
    expect(cleanSnippet('<kbd>⌘</kbd> <kbd>K</kbd> opens it. > **SAY IT** — we cut it.')).toBe(
      '⌘ K opens it. SAY IT — we cut it.'
    )
    expect(cleanSnippet(null)).toBeNull()
  })
})

describe('recent items', () => {
  it('puts the newest first, moves a repeat to the front and caps the list', () => {
    const storage = memoryStorage()
    for (let i = 0; i < RECENT_MAX + 2; i++) pushRecent(hit('page', `r${i}`), storage)
    pushRecent(hit('page', 'r5'), storage)
    const list = readRecent(storage)
    expect(list).toHaveLength(RECENT_MAX)
    expect(list.map(r => r.title).slice(0, 3)).toEqual([
      'r5',
      `r${RECENT_MAX + 1}`,
      `r${RECENT_MAX}`,
    ])
  })

  it('stores under global-search:recent, and keeps only what it needs', () => {
    const storage = memoryStorage()
    pushRecent({ ...hit('page', 'a'), score: 1 } as never, storage)
    expect(RECENT_KEY).toBe('global-search:recent')
    expect(JSON.parse(storage.getItem(RECENT_KEY) ?? '[]')).toEqual([
      { kind: 'page', title: 'a', href: '/x/a', ref: 'a' },
    ])
  })

  it('drops anything unreadable or off-site', () => {
    const storage = memoryStorage({
      [RECENT_KEY]: JSON.stringify([
        { kind: 'page', title: 'ok', href: '/settings', ref: 'p' },
        { kind: 'page', title: 'evil', href: 'https://evil.example', ref: 'x' },
        { kind: 'page', title: 'proto', href: '//evil.example', ref: 'x' },
        { kind: 'page', title: 'slash', href: '/\\evil.example', ref: 'x' },
        { kind: 'Not A Kind', title: 'kind', href: '/a', ref: 'x' },
        'junk',
      ]),
    })
    expect(readRecent(storage).map(r => r.title)).toEqual(['ok'])
    expect(readRecent(memoryStorage({ [RECENT_KEY]: '{not json' }))).toEqual([])
  })
})

describe('balanceHits (the palette)', () => {
  const ranked = [
    ...Array.from({ length: 12 }, (_, i) => hit('document', `d${i}`)),
    hit('page', 'settings'),
    hit('question', 'GQ-1'),
  ]

  it('lets no kind fill the palette when others matched, in rank order', () => {
    const out = balanceHits(ranked, { perKind: 5, total: 10 })
    expect(out.map(h => h.title)).toEqual([
      'd0',
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
      'd6',
      'd7',
      'settings',
      'GQ-1',
    ])
  })

  it('fills from one kind when only one kind matched', () => {
    const only = ranked.filter(h => h.kind === 'document')
    expect(balanceHits(only, { perKind: 5, total: 8 })).toEqual(only.slice(0, 8))
  })
})

describe('ranking, in words', () => {
  it('says how the list was ordered, and why it was not re-ranked', () => {
    const base = { method: 'rrf' as const, k: 60, lists: 3 }
    expect(rankingSummary({ ...base, rerank: { applied: true, model: 'rerank-v3.5' } })).toBe(
      'Ranked by RRF over 3 lists · re-ranked by rerank-v3.5'
    )
    expect(
      rankingSummary({ ...base, lists: 1, rerank: { applied: false, reason: 'timeout' } })
    ).toBe('Ranked by RRF over 1 list · not re-ranked (re-ranker timed out)')
    expect(rankingSummary(undefined)).toBeNull()
  })

  it('names the providers that did not answer', () => {
    expect(
      degradedSummary(
        [
          { provider: 'global-search:documents', reason: 'timeout' },
          { provider: 'acme:x', reason: 'error' },
        ],
        index
      )
    ).toBe('Knowledge base timed out; acme:x failed')
    expect(degradedSummary([], index)).toBeNull()
  })

  it('shows how a hit was found as name / keyword / meaning, numbers in the detail', () => {
    const ind = scoringIndicators(
      {
        sources: [
          { list: 'acme:pages', rank: 1, weight: 1, contribution: 1 / 61 },
          {
            list: 'global-search:documents',
            rank: 3,
            weight: 1,
            contribution: 1 / 63,
            lexical: 4,
            dense: 2,
          },
        ],
        fused: 1 / 61 + 1 / 63,
      },
      index.providerLabel
    )
    expect(ind?.signals.map(s => s.label)).toEqual(['name', 'keyword', 'meaning'])
    expect(ind?.signals[0]?.detail).toBe('Found by name: Pages #1, +0.0164')
    expect(ind?.signals[2]?.detail).toContain('meaning #2')
    expect(ind?.fused).toBe('0.0323')
    expect(ind?.move).toBeNull()
    expect(
      scoringIndicators({
        sources: [
          { list: 'd', rank: 2, weight: 0.5, contribution: 0.5 / 62, lexical: null, dense: 1 },
        ],
        fused: 0.5 / 62,
      })?.signals.map(s => s.label)
    ).toEqual(['meaning'])
  })

  it('marks the re-ranker’s move with the right sign, and names the model', () => {
    const at = (before: number, after: number) =>
      scoringIndicators(
        { sources: [], fused: 0.01, rerank: { score: 0.912, before, after } },
        undefined,
        'rerank-v3.5'
      )?.move
    expect(at(4, 1)).toMatchObject({ mark: '↑3', direction: 'up', score: '0.91' })
    expect(at(2, 4)).toMatchObject({ mark: '↓2', direction: 'down' })
    expect(at(3, 3)).toMatchObject({ mark: '=', direction: 'same' })
    expect(at(4, 1)?.detail).toBe('Re-ranked by rerank-v3.5: score 0.912, from #4 to #1')
    expect(scoringIndicators(undefined)).toBeNull()
  })
})
