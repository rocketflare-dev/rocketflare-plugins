/**
 * The palette's client-side matching (`ui/goto.ts`): the fuzzy score (exact → prefix → word start
 * → substring → subsequence), destination ranking over label, group and keywords, and the command
 * contract's validation — what an invalid `global-search.commands` entry is refused with.
 */
import { describe, expect, it } from 'vitest'
import { KIT_COMMANDS } from '../../ui/commands'
import { type Destination, fuzzyScore, parseCommands, rankDestinations } from '../../ui/goto'

const page = (label: string, group = 'Pages', keywords?: string[]): Destination => ({
  id: `nav:${label}`,
  label,
  to: `/${label.toLowerCase()}`,
  group,
  kind: 'page',
  ...(keywords ? { keywords } : {}),
})

describe('fuzzyScore', () => {
  it('orders exact, prefix, word start, substring, subsequence, none', () => {
    const scores = ['api keys', 'api', 'keys', 'pi k', 'apk', 'xyz'].map(q =>
      fuzzyScore(q, 'API keys')
    )
    expect(scores).toEqual([100, 80, 60, 40, 20, 0])
  })
})

describe('rankDestinations', () => {
  const list = [
    page('Home'),
    page('Settings', 'Organisation'),
    page('People', 'Settings', ['members', 'invite']),
    page('API keys', 'Settings'),
    page('Search'),
  ]

  it('puts the page named by the query before the tabs grouped under it', () => {
    expect(rankDestinations('sett', list, 6).map(d => d.label)).toEqual([
      'Settings',
      'People',
      'API keys',
    ])
  })

  it('matches keywords, caps the list and keeps declared order on ties', () => {
    expect(rankDestinations('inv', list, 6).map(d => d.label)).toEqual(['People'])
    expect(rankDestinations('s', list, 2)).toHaveLength(2)
    expect(rankDestinations('zzz', list, 6)).toEqual([])
  })
})

describe('parseCommands', () => {
  it('accepts the built-in commands', () => {
    const { commands, errors } = parseCommands(KIT_COMMANDS, ['global-search'])
    expect(errors).toEqual([])
    expect(commands.map(c => c.id)).toContain('global-search:invite-people')
  })

  it('refuses a bad entry, a foreign namespace and a duplicate, naming who contributed', () => {
    const { commands, errors } = parseCommands(
      [
        { id: 'acme:open', label: 'Open Acme', to: '/acme' },
        { id: 'acme:open', label: 'Again', to: '/acme' },
        { id: 'other:thing', label: 'Not yours', to: '/x' },
        { id: 'acme:off-site', label: 'Off site', to: 'https://evil.example' },
        { id: 'acme:bad-guard', label: 'Bad guard', to: '/x', guard: 'everyone' },
      ],
      ['acme']
    )
    expect(commands.map(c => c.id)).toEqual(['acme:open'])
    expect(errors).toHaveLength(4)
    expect(errors[0]).toContain("duplicate id 'acme:open'")
    expect(errors[1]).toContain("'other:thing' is not in a contributing plugin's namespace")
    expect(errors[2]).toMatch(/entry 3 \('acme:off-site'\) — to: must be an in-app path/)
    expect(errors[3]).toContain('(contributed by acme)')
  })
})
