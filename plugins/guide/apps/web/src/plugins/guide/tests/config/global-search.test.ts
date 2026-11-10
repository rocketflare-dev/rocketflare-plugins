/**
 * The `global-search.providers` contribution, as the global-search plugin will call it: the fixed
 * id and kinds, the kind filter, an aborted signal, and the hit shape (`/guide?path=…#heading`).
 * `searchGuide` is replaced — its retrieval is proven on Postgres in `tests/api/guide.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchGuide = vi.fn()
vi.mock('../../services/search', () => ({ searchGuide }))

const { guideGlobalSearchProvider, guideHitWeight } = await import('../../services/global-search')

const ctx = (isAdmin: boolean) =>
  ({ db: {}, config: {}, env: {}, scope: {}, tenantId: 't', userId: 'u', isAdmin }) as never
const input = (
  over: Partial<{
    q: string
    pool: number
    kinds: Set<string>
    signal: AbortSignal
    reportSemantic: (state: 'used' | 'unavailable') => void
  }> = {}
) => ({
  q: 'invite',
  pool: 12,
  kinds: new Set<string>(),
  signal: new AbortController().signal,
  ...over,
})

beforeEach(() => {
  searchGuide.mockReset()
  searchGuide.mockResolvedValue({
    semantic: 'used',
    passages: [
      {
        path: 'admin/people.md',
        heading: 'do-it',
        title: 'Managing people › Do it',
        pageTitle: 'Managing people',
        snippet: 'An admin sends an invitation…',
        href: '/guide?path=admin%2Fpeople.md#do-it',
        dense: true,
        text: '…',
        denseRank: 1,
        lexicalRank: 3,
      },
      {
        path: 'start/welcome.md',
        heading: null,
        title: 'Welcome',
        pageTitle: 'Welcome',
        snippet: '',
        href: '/guide?path=start%2Fwelcome.md',
        dense: false,
        text: '…',
        denseRank: null,
        lexicalRank: 1,
      },
    ],
  })
})

describe('guideGlobalSearchProvider', () => {
  it('declares its fixed id and kind', () => {
    expect(guideGlobalSearchProvider.id).toBe('guide:pages')
    expect(guideGlobalSearchProvider.kinds).toEqual([
      { kind: 'guide', label: 'User guide', badge: 'Guide', tone: 'info', order: 50 },
    ])
  })

  it('maps passages to hits linking to the reader, for the caller’s audience', async () => {
    const hits = await guideGlobalSearchProvider.search(ctx(true), input())
    expect(searchGuide).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: 'invite', limit: 12, isAdmin: true })
    )
    expect(hits).toEqual([
      {
        kind: 'guide',
        title: 'Managing people › Do it',
        snippet: 'An admin sends an invitation…',
        ref: 'admin/people.md#do-it',
        href: '/guide?path=admin%2Fpeople.md#do-it',
        weight: 1,
        halves: { lexical: 3, dense: 1 },
      },
      {
        kind: 'guide',
        title: 'Welcome',
        snippet: null,
        ref: 'start/welcome.md',
        href: '/guide?path=start%2Fwelcome.md',
        weight: 0.8,
        halves: { lexical: 1, dense: null },
      },
    ])
  })

  it('meets the contract: in-app hrefs, weights in 0..1 (0.5 dense-only), ≤ pool, limit ≤ 20, the signal, reportSemantic', async () => {
    const reportSemantic = vi.fn()
    const signal = new AbortController().signal
    const hits = await guideGlobalSearchProvider.search(
      ctx(true),
      input({ pool: 1, signal, reportSemantic })
    )
    expect(hits).toHaveLength(1)
    expect(reportSemantic).toHaveBeenCalledWith('used')
    expect(searchGuide.mock.calls[0]?.[1]).toMatchObject({ limit: 1, signal })
    await guideGlobalSearchProvider.search(ctx(true), input({ pool: 200 }))
    expect(searchGuide.mock.calls[1]?.[1].limit).toBe(20)
    const all = await guideGlobalSearchProvider.search(ctx(true), input())
    for (const h of all) {
      expect(h.href.startsWith('/')).toBe(true)
      expect(h.weight).toBeGreaterThanOrEqual(0)
      expect(h.weight).toBeLessThanOrEqual(1)
    }
    expect(guideHitWeight({ denseRank: 2, lexicalRank: null })).toBe(0.5)
    expect(guideGlobalSearchProvider.id).toMatch(/^guide:[a-z0-9-]+$/)
  })

  it('passes a member as a member', async () => {
    await guideGlobalSearchProvider.search(ctx(false), input())
    expect(searchGuide.mock.calls[0]?.[1]).toMatchObject({ isAdmin: false })
  })

  it('answers nothing when the kind filter excludes the guide, or the search was aborted', async () => {
    expect(
      await guideGlobalSearchProvider.search(ctx(true), input({ kinds: new Set(['doc']) }))
    ).toEqual([])
    const aborted = new AbortController()
    aborted.abort()
    expect(
      await guideGlobalSearchProvider.search(ctx(true), input({ signal: aborted.signal }))
    ).toEqual([])
    expect(searchGuide).not.toHaveBeenCalled()
    expect(
      await guideGlobalSearchProvider.search(ctx(true), input({ kinds: new Set(['guide']) }))
    ).toHaveLength(2)
  })
})
