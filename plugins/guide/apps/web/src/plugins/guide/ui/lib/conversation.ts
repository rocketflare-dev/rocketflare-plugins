/**
 * The ONE "Ask the Guide" conversation of this tab — the transcript, the in-flight searches, the
 * streaming flag and whether the slide-over is open — held in a module-level store, so the header's
 * slide-over and the reader's Ask pane (two lazy chunks sharing this module) show the same
 * conversation and it survives navigation. Nothing is persisted: a reload starts afresh, and the
 * server is stateless.
 *
 * Each send owns an `AbortController`: `stop()` and `reset()` abort it, so a closed panel never
 * leaves a model generating for nobody.
 */
import {
  cleanGuideAnswer,
  GUIDE_MAX_HISTORY,
  GUIDE_MAX_QUESTION,
  GUIDE_MAX_TURN,
  GUIDE_PATH,
  type GuideChatTurn,
  type GuideCitation,
} from '@rocketflare/shared/plugins/guide/index'
import { useSyncExternalStore } from 'react'
import type { GuideAskHandlers } from './ask'

export interface GuideChatMessage {
  role: 'user' | 'assistant'
  content: string
  citations?: GuideCitation[]
  /** Found by keywords only (no platform embedder) — said under the answer, never hidden. */
  lexicalOnly?: boolean
  /** The answer failed or was stopped: shown, but never sent back as history. */
  error?: boolean
}

export interface GuideConversationState {
  messages: GuideChatMessage[]
  steps: string[]
  streaming: boolean
  panelOpen: boolean
}

export type GuideStreamer = (
  body: { question: string; history: GuideChatTurn[]; screen?: { route: string } },
  handlers: GuideAskHandlers,
  signal: AbortSignal
) => Promise<void>

export const STOPPED_MESSAGE = 'Stopped.'

/**
 * The turns sent back with the next question: every completed exchange, nothing from one whose
 * answer failed — a model that re-reads its own error text as something it said builds on it.
 */
export function guideHistory(messages: readonly GuideChatMessage[]): GuideChatTurn[] {
  const turns: GuideChatTurn[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as GuideChatMessage
    const answer = m.role === 'user' ? messages[i + 1] : undefined
    if (m.role === 'user' && answer?.role === 'assistant' && answer.error) {
      i++
      continue
    }
    if (m.error || !m.content.trim()) continue
    turns.push({ role: m.role, content: m.content.slice(0, GUIDE_MAX_TURN) })
  }
  return turns.slice(-GUIDE_MAX_HISTORY)
}

/**
 * The streamed text as the reader sees it: no trailing `CITATIONS:` block (shown as links once
 * resolved) and no footnote marks — the same cleaning the server applies (`cleanGuideAnswer`).
 */
export function stripCitationsBlock(text: string): string {
  return cleanGuideAnswer(text)
}

/** A conversation store — one per tab in the app ({@link guideConversation}); tests make their own. */
export function createGuideConversation(stream: GuideStreamer) {
  let state: GuideConversationState = {
    messages: [],
    steps: [],
    streaming: false,
    panelOpen: false,
  }
  const listeners = new Set<() => void>()
  let inFlight: AbortController | null = null
  let askPane: (() => void) | null = null

  const set = (next: Partial<GuideConversationState>) => {
    state = { ...state, ...next }
    for (const l of listeners) l()
  }
  const updateAssistant = (
    controller: AbortController,
    update: (m: GuideChatMessage) => GuideChatMessage
  ) => {
    if (inFlight !== controller && controller.signal.aborted) return
    const messages = [...state.messages]
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') messages[messages.length - 1] = update(last)
    set({ messages })
  }

  async function send(raw: string, route?: string): Promise<void> {
    const question = raw.trim().slice(0, GUIDE_MAX_QUESTION)
    if (!question || inFlight) return
    const controller = new AbortController()
    inFlight = controller
    const history = guideHistory(state.messages)
    set({
      streaming: true,
      steps: [],
      messages: [
        ...state.messages,
        { role: 'user', content: question },
        { role: 'assistant', content: '' },
      ],
    })
    try {
      await stream(
        { question, history, ...(route ? { screen: { route: route.slice(0, 300) } } : {}) },
        {
          onDelta: text => updateAssistant(controller, m => ({ ...m, content: m.content + text })),
          onProgress: (_tool, query) =>
            set({
              steps: [
                ...state.steps,
                query ? `Searching the guide for “${query}”` : 'Searching the guide',
              ],
            }),
          onDone: answer => {
            updateAssistant(controller, m => ({
              ...m,
              content: answer.answer || stripCitationsBlock(m.content),
              citations: answer.citations,
              lexicalOnly: answer.retrieval === 'lexical',
            }))
            set({ steps: [] })
          },
          onError: message => {
            updateAssistant(controller, m => ({ ...m, content: message, error: true }))
            set({ steps: [] })
          },
        },
        controller.signal
      )
      if (controller.signal.aborted) {
        updateAssistant(controller, m =>
          m.citations ? m : { ...m, content: m.content || STOPPED_MESSAGE, error: true }
        )
      }
    } catch (err) {
      updateAssistant(controller, m => ({
        ...m,
        content: err instanceof Error ? err.message : 'The guide could not answer.',
        error: true,
      }))
    } finally {
      if (inFlight === controller) {
        inFlight = null
        set({ streaming: false, steps: [] })
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send,
    stop: () => inFlight?.abort(),
    reset() {
      const running = inFlight
      inFlight = null
      running?.abort()
      set({ messages: [], steps: [], streaming: false })
    },
    openPanel: () => set({ panelOpen: true }),
    closePanel: () => set({ panelOpen: false }),
    /** The reader registers its Ask pane while it is open; the header's `?` then focuses it. */
    registerAskPane(focus: (() => void) | null) {
      askPane = focus
    },
    /** The header button and the `?` key: focus the reader's pane on `/guide`, else open the panel. */
    summon(pathname: string) {
      if (pathname === GUIDE_PATH && askPane) {
        set({ panelOpen: false })
        askPane()
      } else set({ panelOpen: true })
    },
  }
}

export type GuideConversation = ReturnType<typeof createGuideConversation>

/** This tab's conversation. The AG-UI client is imported on the first question, never eagerly. */
export const guideConversation: GuideConversation = createGuideConversation(
  async (body, handlers, signal) => {
    const { streamGuideAsk } = await import('./ask')
    return streamGuideAsk(body, handlers, signal)
  }
)

export function useGuideConversation(
  conversation: GuideConversation = guideConversation
): GuideConversationState {
  return useSyncExternalStore(conversation.subscribe, conversation.getState, conversation.getState)
}
