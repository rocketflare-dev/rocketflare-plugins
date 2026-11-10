/**
 * "Ask the Guide" — one conversation, hosted twice: in the reader's right-hand pane and in the
 * header's slide-over. Both read the same store (`lib/conversation`). A citation opens the cited
 * page at its heading; `onNavigate` lets the slide-over close itself.
 *
 * The answer is MODEL OUTPUT, so it renders with `skipHtml` — never raw HTML.
 */
import {
  BookOpenIcon,
  PaperAirplaneIcon,
  SparklesIcon,
  StopIcon,
} from '@heroicons/react/24/outline'
import { type GuideCitation, guideHref } from '@rocketflare/shared/plugins/guide/index'
import { type RefObject, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import {
  type GuideConversation,
  guideConversation,
  stripCitationsBlock,
  useGuideConversation,
} from '../lib/conversation'

/** A link to a guide page stays in the app (the slide-over closes on the route change). */
const ANSWER_COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    href?.startsWith('/guide?') ? (
      <Link to={href} className="link link-primary">
        {children}
      </Link>
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
}

/** A citation chip: the page, and what it supports when the model said. */
export function citationLabel(c: GuideCitation): string {
  return c.note && c.note !== c.title ? `${c.title} — ${c.note}` : c.title
}

export default function GuideChat({
  onNavigate,
  inputRef,
  conversation = guideConversation,
}: {
  onNavigate?: () => void
  inputRef?: RefObject<HTMLTextAreaElement | null>
  conversation?: GuideConversation
}) {
  const { messages, steps, streaming } = useGuideConversation(conversation)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/steps are the triggers
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, steps])

  const openCitation = (c: GuideCitation) => {
    if (!c.valid || !c.page) return
    navigate(guideHref(c.page, c.heading))
    onNavigate?.()
  }

  const submit = () => {
    const question = input.trim()
    if (!question || streaming) return
    setInput('')
    void conversation.send(question, pathname)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={streaming}
        aria-label="Conversation with the guide"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
      >
        {messages.length === 0 && (
          <div className="mt-6 space-y-2 text-center text-sm text-base-content/60">
            <SparklesIcon className="mx-auto h-8 w-8 text-primary" />
            <p>Ask how anything in this app works.</p>
            <p className="text-xs">Answers come from the guide, with links to the page.</p>
          </div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const display = m.role === 'assistant' ? stripCitationsBlock(m.content) : m.content
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: an append-only chat log
              key={i}
              className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'whitespace-pre-wrap bg-primary text-primary-content'
                    : m.error
                      ? 'bg-base-200 text-error'
                      : 'bg-base-200 text-base-content'
                }`}
                data-error={m.error ? 'true' : undefined}
              >
                {m.role === 'assistant' ? (
                  display ? (
                    m.error ? (
                      <p>{display}</p>
                    ) : (
                      <div className="prose prose-sm max-w-none">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={ANSWER_COMPONENTS}
                          skipHtml
                        >
                          {display}
                        </ReactMarkdown>
                      </div>
                    )
                  ) : (
                    isLast &&
                    streaming && (
                      <ul className="space-y-1 text-xs text-base-content/60" aria-label="Searching">
                        {(steps.length ? steps : ['Thinking…']).map((s, si) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: append-only steps
                          <li key={si} className="flex items-center gap-1.5">
                            <span className="loading loading-dots loading-xs" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    )
                  )
                ) : (
                  display
                )}
                {m.citations && m.citations.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5 border-t border-base-content/10 pt-2">
                    {m.citations.map((c, ci) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a static citation list
                      <li key={ci}>
                        <button
                          type="button"
                          disabled={!c.valid || !c.page}
                          onClick={() => openCitation(c)}
                          className="badge badge-outline gap-1 py-2.5 text-xs hover:border-primary hover:text-primary disabled:opacity-60"
                          title={
                            c.valid ? 'Open this page of the guide' : 'Not a page you can open'
                          }
                        >
                          <BookOpenIcon className="h-3.5 w-3.5 flex-none" />
                          <span className="max-w-[16rem] truncate">{citationLabel(c)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {m.lexicalOnly && (
                  <p className="mt-1.5 text-[11px] text-base-content/60">
                    Found by keyword search — the guide's semantic index is not available.
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-t border-base-300 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={2}
            placeholder="Ask the guide…"
            aria-label="Ask the guide"
            className="textarea textarea-bordered textarea-sm flex-1 resize-none"
          />
          {streaming ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square"
              onClick={() => conversation.stop()}
              aria-label="Stop"
              title="Stop answering"
            >
              <StopIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm btn-square"
              onClick={submit}
              disabled={!input.trim()}
              aria-label="Send"
            >
              <PaperAirplaneIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        {messages.length > 0 && !streaming && (
          <button
            type="button"
            className="link link-primary mt-1.5 text-xs"
            onClick={() => conversation.reset()}
          >
            New conversation
          </button>
        )}
      </div>
    </div>
  )
}
