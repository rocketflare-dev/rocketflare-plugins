/**
 * The ONE "Ask the Guide" conversation the header slide-over and the reader share: what a send
 * records, what goes back as history (never a failed answer), stop, reset and summon — and the
 * header's `?` key, which never fires while the person is typing.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { GuideAskHandlers } from '../../ui/lib/ask'
import {
  createGuideConversation,
  type GuideStreamer,
  guideConversation,
  guideHistory,
  STOPPED_MESSAGE,
  stripCitationsBlock,
} from '../../ui/lib/conversation'

function scripted(run: (h: GuideAskHandlers, signal: AbortSignal) => Promise<void> | void) {
  const calls: Parameters<GuideStreamer>[0][] = []
  const stream: GuideStreamer = async (body, handlers, signal) => {
    calls.push(body)
    await run(handlers, signal)
  }
  return { conversation: createGuideConversation(stream), calls }
}

describe('the conversation store', () => {
  it('streams deltas, then replaces the text with the resolved answer and its citations', async () => {
    const { conversation, calls } = scripted(h => {
      h.onDelta('Open People.')
      h.onDelta('\n\nCITATIONS:\npage=a.md | heading=- | note=-')
      h.onDone({
        answer: 'Open People.',
        citations: [{ page: 'a.md', heading: null, title: 'A', note: null, valid: true }] as never,
        retrieval: 'lexical',
      })
    })
    await conversation.send('  How do I invite?  ', '/settings/people')
    expect(calls[0]).toEqual({
      question: 'How do I invite?',
      history: [],
      screen: { route: '/settings/people' },
    })
    const [user, answer] = conversation.getState().messages
    expect(user).toEqual({ role: 'user', content: 'How do I invite?' })
    expect(answer).toMatchObject({ role: 'assistant', content: 'Open People.', lexicalOnly: true })
    expect(answer?.citations).toHaveLength(1)
    expect(conversation.getState().streaming).toBe(false)
  })

  it('never sends a failed exchange back as history', async () => {
    let fail = true
    const { conversation, calls } = scripted(h => {
      if (fail) h.onError('The model is unavailable.', 'ai_unavailable')
      else h.onDone({ answer: 'Fine.', citations: [], retrieval: 'hybrid' })
    })
    await conversation.send('first')
    expect(conversation.getState().messages[1]).toMatchObject({ error: true })
    fail = false
    await conversation.send('second')
    await conversation.send('third')
    expect(calls[1]?.history).toEqual([])
    expect(calls[2]?.history).toEqual([
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'Fine.' },
    ])
  })

  it('stop aborts the stream and marks the answer stopped; reset clears it all', async () => {
    let release: () => void = () => {}
    const { conversation } = scripted(
      (_h, signal) =>
        new Promise<void>(resolve => {
          release = resolve
          signal.addEventListener('abort', () => resolve())
        })
    )
    const sending = conversation.send('slow')
    expect(conversation.getState().streaming).toBe(true)
    conversation.stop()
    await sending
    expect(conversation.getState().messages[1]).toMatchObject({
      content: STOPPED_MESSAGE,
      error: true,
    })
    release()
    conversation.reset()
    expect(conversation.getState()).toMatchObject({ messages: [], streaming: false })
  })

  it('summon focuses the reader’s pane on /guide, and opens the panel anywhere else', () => {
    const { conversation } = scripted(() => {})
    const focus = vi.fn()
    conversation.summon('/settings')
    expect(conversation.getState().panelOpen).toBe(true)
    conversation.closePanel()
    conversation.registerAskPane(focus)
    conversation.summon('/guide')
    expect(focus).toHaveBeenCalledOnce()
    expect(conversation.getState().panelOpen).toBe(false)
  })

  it('helpers: history drops blanks and errors; the citations block is stripped', () => {
    expect(
      guideHistory([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'oops', error: true },
      ])
    ).toEqual([{ role: 'user', content: 'a' }])
    expect(stripCitationsBlock('Answer.\nCITATIONS:\npage=x')).toBe('Answer.')
  })
})

describe('the header button', () => {
  it('? opens Ask the Guide — not while typing, not with a modifier; Escape closes it', async () => {
    const { default: GuideHeaderButton } = await import('../../ui/header/GuideHeaderButton')
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <input aria-label="Somewhere to type" />
        <GuideHeaderButton />
      </MemoryRouter>
    )
    const input = screen.getByLabelText('Somewhere to type')
    fireEvent.keyDown(input, { key: '?' })
    expect(guideConversation.getState().panelOpen).toBe(false)
    fireEvent.keyDown(document.body, { key: '?', metaKey: true })
    expect(guideConversation.getState().panelOpen).toBe(false)
    act(() => {
      fireEvent.keyDown(document.body, { key: '?' })
    })
    expect(guideConversation.getState().panelOpen).toBe(true)
    expect(await screen.findByRole('complementary', { name: 'Ask the Guide' })).toBeTruthy()
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' })
    })
    expect(guideConversation.getState().panelOpen).toBe(false)
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask the Guide' }))
    })
    expect(guideConversation.getState().panelOpen).toBe(true)
    act(() => guideConversation.closePanel())
  })
})
