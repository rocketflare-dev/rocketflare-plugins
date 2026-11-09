/**
 * The review step of a conversation: what a person is shown before anything reaches GitHub.
 */
import type { AgentRunWithEvents } from '@rocketflare/shared/ai/agents'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { conversationOf, DraftBody, FilingNotice } from '../../ui/pages/ReportConversationPage'

const at = new Date('2026-11-09T10:00:00Z')

function runWith(message: string): AgentRunWithEvents {
  return {
    input: { description: 'The calendar is wrong.' },
    createdAt: at,
    events: [],
    interrupts: [
      {
        id: 'i1',
        status: 'pending',
        kind: 'choice',
        spec: { kind: 'choice', title: 'Log this bug on GitHub?', message, options: [] },
        createdAt: at,
        updatedAt: at,
        resolvedAt: null,
        payload: null,
      },
    ],
  } as unknown as AgentRunWithEvents
}

describe('the review step', () => {
  it('shows the title the issue will be filed under', () => {
    const items = conversationOf(runWith('New issue (bug): Moved order keeps its old day\n\nBody.'))
    expect(items.find(i => i.kind === 'draft')).toMatchObject({
      heading: 'New issue (bug): Moved order keeps its old day',
      body: 'Body.',
    })
  })

  it('says the conversation goes to GitHub with the draft', () => {
    const html = renderToStaticMarkup(<FilingNotice />)
    expect(html).toMatch(/whole conversation above/)
    expect(html).toMatch(/your name/)
  })

  it('renders an image in the draft as a link and loads nothing', () => {
    const html = renderToStaticMarkup(<DraftBody body="See ![p](https://cdn.example.test/p.png)" />)
    expect(html).not.toContain('<img')
    expect(html).toContain('https://cdn.example.test/p.png')
  })
})
