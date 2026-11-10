/**
 * The guide's loader (`@rocketflare/shared/plugins/guide`) — the one implementation the build
 * script, the server and these tests all read the guide through: config validation, frontmatter,
 * headings, facts, links, images, sections and the generated module.
 */
import {
  buildGuideBundle,
  type GuideSourceFile,
  guideConfigSchema,
  guideExternalId,
  guideHref,
  guideLinkHref,
  guideSvgProblems,
  parseFrontmatter,
  parseGuideExternalId,
  renderGuideModule,
  resolveGuideFacts,
  slugifyHeading,
  validateGuideConfig,
} from '@rocketflare/shared/plugins/guide/index'
import { describe, expect, it } from 'vitest'
import { guideScreenContext, guideScreenPage, guideViewFor } from '../../content'
import {
  dedupeGuideCitations,
  resolveGuideCitation,
  splitGuideCitations,
} from '../../services/citations'
import { buildFixture, FIXTURE_CONFIG, FIXTURE_FILES, sha256 } from '../fixture'

const problemsOf = (files: GuideSourceFile[]) => {
  const built = buildGuideBundle({ files, images: [], hash: sha256 })
  return built.problems.map(p => `${p.file}: ${p.message}`)
}
const withPage = (path: string, raw: string) => [
  ...FIXTURE_FILES.filter(f => f.path !== path),
  { path, raw },
]
const replaceIn = (path: string, from: string, to: string) => {
  const f = FIXTURE_FILES.find(x => x.path === path)
  if (!f) throw new Error(path)
  return withPage(path, f.raw.replace(from, to))
}

describe('config', () => {
  it('accepts the fixture and agrees with the zod schema', () => {
    const v = validateGuideConfig(FIXTURE_CONFIG)
    expect(v.problems).toEqual([])
    expect(guideConfigSchema.parse(FIXTURE_CONFIG)).toEqual(v.config)
  })

  it('names every problem, unknown keys included, and the zod schema refuses the same', () => {
    const bad = { ...FIXTURE_CONFIG, appName: '', extra: true, parts: [] }
    const v = validateGuideConfig(bad)
    expect(v.config).toBeNull()
    expect(v.problems.join('\n')).toMatch(/appName/)
    expect(v.problems.join('\n')).toMatch(/extra/)
    expect(guideConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('defaults the label', () => {
    const { label: _l, ...rest } = FIXTURE_CONFIG
    expect(validateGuideConfig(rest).config?.label).toBe('User guide')
  })
})

describe('frontmatter', () => {
  it('reads scalars, quoted strings and flow and block lists', () => {
    const { data, body } = parseFrontmatter(
      '---\ntitle: "A: b"\norder: 2\nsources: [a/**, "b.ts"]\ntags:\n  - x\n  - y\n---\n\nBody'
    )
    expect(data).toEqual({ title: 'A: b', order: 2, sources: ['a/**', 'b.ts'], tags: ['x', 'y'] })
    expect(body.trim()).toBe('Body')
  })

  it('an all-digit verified must be quoted, or YAML reads a number', () => {
    const problems = problemsOf(
      replaceIn('start/reports.md', 'verified: "1234567"', 'verified: 1234567')
    )
    expect(problems.join('\n')).toMatch(/start\/reports\.md: .*quote/)
  })

  it('refuses an unknown part, section or audience', () => {
    const problems = problemsOf(
      replaceIn('start/reports.md', 'audience: member', 'audience: everyone')
    ).join('\n')
    expect(problems).toMatch(/audience/)
    expect(
      problemsOf(replaceIn('start/reports.md', 'section: basics', 'section: nope')).join('\n')
    ).toMatch(/section/)
  })
})

describe('headings, facts and links', () => {
  it('slugs headings the way the reader anchors them', () => {
    expect(slugifyHeading('Reading a report')).toBe('reading-a-report')
    expect(slugifyHeading("What's new? (2026)")).toBe('whats-new-2026')
  })

  it('resolves facts and reports unknown keys rather than guessing', () => {
    expect(resolveGuideFacts('In {{fact:a}} and {{ fact:b }}.', { a: '7' })).toEqual({
      text: 'In 7 and {{ fact:b }}.',
      unknown: ['b'],
    })
    expect(
      problemsOf(replaceIn('admin/people.md', 'invite.days', 'invite.weeks')).join('\n')
    ).toMatch(/unknown fact \{\{fact:invite\.weeks\}\}/)
  })

  it('fails a link to a missing page or heading, and a member page linking to an admin one', () => {
    expect(
      problemsOf(
        replaceIn('start/welcome.md', 'reports.md#reading-a-report', 'reports.md#nope')
      ).join('\n')
    ).toMatch(/start\/welcome\.md: .*nope/)
    expect(
      problemsOf(replaceIn('start/welcome.md', 'reports.md#reading-a-report', 'gone.md')).join('\n')
    ).toMatch(/gone\.md/)
    expect(
      problemsOf(
        replaceIn('start/welcome.md', 'reports.md#reading-a-report', '../admin/people.md')
      ).join('\n')
    ).toMatch(/admin/)
  })

  it('refuses headings deeper than ###', () => {
    expect(
      problemsOf(replaceIn('start/reports.md', '## Reading', '#### Reading')).join('\n')
    ).toMatch(/####|H4|deeper/i)
  })

  it('refuses a screens entry that points at a missing page', () => {
    const cfg = { ...FIXTURE_CONFIG, screens: { '/x': 'admin/people.md', '/y': 'start/none.md' } }
    const files = [
      ...FIXTURE_FILES.filter(f => f.path !== 'guide.config.json'),
      { path: 'guide.config.json', raw: JSON.stringify(cfg) },
    ]
    expect(problemsOf(files)).toEqual([
      'guide.config.json: screens["/y"] names "start/none.md", which is not a page',
    ])
  })

  it('rewrites links between pages into reader URLs', () => {
    expect(guideLinkHref('reports.md#reading-a-report', 'start/welcome.md')).toBe(
      guideHref('start/reports.md', 'reading-a-report')
    )
    expect(guideLinkHref('https://example.com', 'start/welcome.md')).toBe('https://example.com')
    expect(guideHref('start/reports.md', 'reading-a-report')).toBe(
      '/guide?path=start%2Freports.md#reading-a-report'
    )
  })
})

describe('SVG safety', () => {
  it('accepts a plain drawing with a title and refuses script, handlers and outside references', () => {
    expect(
      guideSvgProblems(
        '<svg xmlns="http://www.w3.org/2000/svg"><title>A box</title><rect width="1" height="1"/></svg>'
      )
    ).toEqual([])
    expect(
      guideSvgProblems('<svg><title>x</title><script>alert(1)</script></svg>').length
    ).toBeGreaterThan(0)
    expect(
      guideSvgProblems('<svg><title>x</title><rect onclick="x()"/></svg>').length
    ).toBeGreaterThan(0)
    expect(
      guideSvgProblems('<svg><title>x</title><image href="https://evil.test/a.png"/></svg>').length
    ).toBeGreaterThan(0)
    expect(guideSvgProblems('<svg><rect/></svg>').join('\n')).toMatch(/title/)
  })
})

describe('the bundle', () => {
  const bundle = buildFixture()

  it('skips VOICE.md, orders pages by part, section and order, and resolves facts', () => {
    expect(bundle.pages.map(p => p.path)).toEqual([
      'start/welcome.md',
      'start/reports.md',
      'admin/people.md',
    ])
    const people = bundle.pages.find(p => p.path === 'admin/people.md')
    expect(people?.markdown).toContain('expires after 7 days')
    expect(people?.markdown).not.toMatch(/^# Managing people/m)
  })

  it('splits each page at H2 into titled sections, the text led by its title', () => {
    const welcome = bundle.pages[0]
    expect(welcome?.sections.map(s => [s.heading, s.title])).toEqual([
      [null, 'Welcome'],
      ['finding-your-way', 'Welcome › Finding your way'],
      ['watch-out-for', 'Welcome › Watch out for'],
    ])
    expect(welcome?.sections[1]?.text).toMatch(/^Welcome › Finding your way\n\n/)
    expect(welcome?.sections[1]?.text).toContain('/guide?path=start%2Freports.md#reading-a-report')
  })

  it('is deterministic, and its hash moves with any page', () => {
    expect(renderGuideModule(buildFixture())).toBe(renderGuideModule(bundle))
    const moved = buildFixture(replaceIn('start/reports.md', 'newest first', 'oldest first'))
    expect(moved.hash).not.toBe(bundle.hash)
  })

  it('round-trips the external id of a section', () => {
    expect(guideExternalId('start/reports.md', 'reading-a-report')).toBe(
      'start/reports.md#reading-a-report'
    )
    expect(parseGuideExternalId('start/reports.md#reading-a-report')).toEqual({
      path: 'start/reports.md',
      heading: 'reading-a-report',
    })
    expect(parseGuideExternalId('start/reports.md')).toEqual({
      path: 'start/reports.md',
      heading: null,
    })
  })
})

describe('the audience view, screens and citations', () => {
  const bundle = buildFixture()

  it('a member sees no admin page; an admin sees all', () => {
    expect(guideViewFor(false, bundle).entries.map(e => e.path)).toEqual([
      'start/welcome.md',
      'start/reports.md',
    ])
    expect(guideViewFor(true, bundle).pages.has('admin/people.md')).toBe(true)
  })

  it('maps a route to its page by the longest prefix on a segment boundary, within the audience', () => {
    const member = guideViewFor(false, bundle)
    const admin = guideViewFor(true, bundle)
    expect(guideScreenPage('/reports/42', member, bundle)?.path).toBe('start/reports.md')
    expect(guideScreenPage('/', member, bundle)?.path).toBe('start/welcome.md')
    expect(guideScreenPage('/reportsx', member, bundle)).toBeNull()
    expect(guideScreenPage('/settings/people', member, bundle)).toBeNull()
    expect(guideScreenPage('/settings/people', admin, bundle)?.path).toBe('admin/people.md')
    expect(guideScreenContext(undefined, member)).toBeUndefined()
    expect(guideScreenContext('/settings', admin, bundle)).toContain(
      '"Managing people" (admin/people.md)'
    )
    expect(guideScreenContext('/settings', member, bundle)).toBeUndefined()
  })

  it('parses the CITATIONS block and resolves each against the reader’s view', () => {
    const { answer, citations } = splitGuideCitations(
      'Open People.\n\nCITATIONS:\npage=admin/people.md | heading=do-it | note=sending one\npage=start/reports.md | heading=made-up | note=-\npage=nowhere.md | heading=- | note=x'
    )
    expect(answer).toBe('Open People.')
    const member = guideViewFor(false, bundle)
    const admin = guideViewFor(true, bundle)
    const forAdmin = citations.map(c => resolveGuideCitation(c, admin))
    expect(forAdmin[0]).toMatchObject({ valid: true, page: 'admin/people.md', heading: 'do-it' })
    expect(forAdmin[1]).toMatchObject({ valid: true, page: 'start/reports.md', heading: null })
    expect(forAdmin[2]?.valid).toBe(false)
    // An admin page cited to a member is not a page they can open.
    expect(resolveGuideCitation(citations[0] as never, member).valid).toBe(false)
    expect(dedupeGuideCitations([...forAdmin, ...forAdmin]).length).toBe(forAdmin.length)
  })
})
