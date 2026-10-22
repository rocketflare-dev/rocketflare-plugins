import { describe, expect, it } from 'vitest'
import { buildIssueBody, GITHUB_BODY_MAX } from '../../services/issue-body'

const draft = {
  mode: 'new' as const,
  kind: 'enhancement' as const,
  title: 'Filter bookings by guide',
  body: '**Problem**\nHard to see one guide’s week.',
}

describe('buildIssueBody', () => {
  it('summary, then who and where, then the whole conversation folded away', () => {
    const body = buildIssueBody({
      draft,
      reporterName: 'Sam',
      pagePath: '/orders',
      transcript: [
        { speaker: 'reporter', text: 'I want to filter by guide.' },
        { speaker: 'agent', text: 'Which page?\nThe list or the calendar?' },
        { speaker: 'reporter', text: 'Both.' },
      ],
    })
    expect(body.startsWith('**Problem**')).toBe(true)
    expect(body).toContain('**Reported by:** Sam, through Ideas & issues in the app')
    expect(body).toContain('**Page:** `/orders`')
    expect(body).toContain(
      '**Assistant:**\n> Which page?\n> The list or the calendar?\n\n**Sam:**\n> Both.'
    )
    expect(body.trimEnd().endsWith('</details>')).toBe(true)
  })

  it('a comment says who else reported it; no page line without a page', () => {
    const body = buildIssueBody({
      draft: { ...draft, mode: 'comment', existingIssueNumber: 3 },
      reporterName: 'Sam',
      transcript: [],
    })
    expect(body.startsWith('**Also reported by Sam.**')).toBe(true)
    expect(body).not.toContain('**Page:**')
  })

  it('a long conversation is cut from the start to fit GitHub, keeping the latest answers', () => {
    const body = buildIssueBody({
      draft,
      reporterName: 'Sam',
      transcript: [
        { speaker: 'reporter', text: `FIRST ${'x'.repeat(70_000)}` },
        { speaker: 'reporter', text: 'LAST ANSWER' },
      ],
    })
    expect(body.length).toBeLessThanOrEqual(GITHUB_BODY_MAX)
    expect(body).toContain('LAST ANSWER')
    expect(body).not.toContain('FIRST')
    expect(body).toContain('cut to fit')
  })
})
