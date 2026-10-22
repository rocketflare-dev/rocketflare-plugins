/**
 * `/ideas-and-issues/:runId` — the conversation. It is drawn entirely from the run: the opening
 * description is its input, each question and its answer is an `ask:<n>` interrupt, each draft and
 * the person's verdict a `review:<n>` one, searches are `step` events, and the logged issue is the
 * output. Answering is the kit's interrupt route; Discard is the kit's cancel.
 */
import { ChatBubbleLeftEllipsisIcon } from '@heroicons/react/24/outline'
import {
  type AgentRunWithEvents,
  agentStepEventDataSchema,
  isRunActive,
} from '@rocketflare/shared/ai/agents'
import { type AgentRunInterrupt, choicePayloadSchema } from '@rocketflare/shared/ai/interrupts'
import {
  ISSUE_REPORT_FILE_CHOICE,
  issueReportInputSchema,
  issueReportOutputSchema,
} from '@rocketflare/shared/plugins/issue-reports/index'
import { type FormEvent, type KeyboardEvent, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useParams } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import { z } from 'zod'
import { EmptyState, LoadingIndicator, PageHeader } from '@/plugins/api/ui'
import {
  useAnswerIssueReport,
  useDiscardIssueReport,
  useIssueReport,
} from '../hooks/useIssueReports'

type Item =
  | { kind: 'reporter'; id: string; at: Date; text: string }
  | { kind: 'agent'; id: string; at: Date; text: string }
  | { kind: 'draft'; id: string; at: Date; title: string; body: string }
  | { kind: 'note'; id: string; at: Date; text: string }

const textPayload = z.object({ text: z.string() })

function answerText(interrupt: AgentRunInterrupt): string | null {
  if (interrupt.status !== 'resolved') return null
  if (interrupt.kind === 'input') return textPayload.safeParse(interrupt.payload).data?.text ?? null
  const value = choicePayloadSchema.safeParse(interrupt.payload).data?.value
  if (!value) return null
  return value === ISSUE_REPORT_FILE_CHOICE ? 'Looks good — log it.' : value
}

/** The run, flattened into what was said, in the order it was said. */
export function conversationOf(run: AgentRunWithEvents): Item[] {
  const items: Item[] = []
  const input = issueReportInputSchema.safeParse(run.input)
  items.push({
    kind: 'reporter',
    id: 'opening',
    at: run.createdAt,
    text: input.success ? input.data.description : '',
  })
  for (const interrupt of run.interrupts) {
    if (interrupt.spec.kind === 'input') {
      items.push({
        kind: 'agent',
        id: interrupt.id,
        at: interrupt.createdAt,
        text: interrupt.spec.message,
      })
    } else if (interrupt.spec.kind === 'choice') {
      const [, ...body] = interrupt.spec.message.split('\n\n')
      items.push({
        kind: 'draft',
        id: interrupt.id,
        at: interrupt.createdAt,
        title: interrupt.spec.title ?? 'Draft',
        body: body.join('\n\n'),
      })
    }
    const answer = answerText(interrupt)
    if (answer && interrupt.resolvedAt) {
      items.push({
        kind: 'reporter',
        id: `${interrupt.id}:answer`,
        at: interrupt.resolvedAt,
        text: answer,
      })
    } else if (interrupt.status === 'cancelled' || interrupt.status === 'expired') {
      items.push({
        kind: 'note',
        id: `${interrupt.id}:skipped`,
        at: interrupt.resolvedAt ?? interrupt.updatedAt,
        text: interrupt.status === 'expired' ? 'Nobody answered in time.' : 'Skipped.',
      })
    }
  }
  for (const event of run.events) {
    if (event.type !== 'step') continue
    const step = agentStepEventDataSchema.safeParse(event.data)
    if (!step.success || step.data.status !== 'done' || !step.data.key.startsWith('search:'))
      continue
    items.push({
      kind: 'note',
      id: event.id,
      at: event.at,
      text: `${step.data.label}${step.data.detail ? ` — ${step.data.detail}` : ''}`,
    })
  }
  return items.sort((a, b) => a.at.getTime() - b.at.getTime())
}

function Bubble({ item }: { item: Item }) {
  if (item.kind === 'note') {
    return <p className="text-center text-xs text-base-content/60">{item.text}</p>
  }
  if (item.kind === 'draft') {
    return (
      <div className="surface-panel border border-primary/30 p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">{item.title}</p>
        <div className="prose prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {item.body}
          </ReactMarkdown>
        </div>
      </div>
    )
  }
  const mine = item.kind === 'reporter'
  return (
    <div className={`chat ${mine ? 'chat-end' : 'chat-start'}`}>
      <div
        className={`chat-bubble whitespace-pre-wrap ${mine ? 'chat-bubble-primary' : 'bg-base-200 text-base-content'}`}
      >
        {item.text}
      </div>
    </div>
  )
}

function Composer({
  placeholder,
  busy,
  onSend,
}: {
  placeholder: string
  busy: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const send = (event?: FormEvent) => {
    event?.preventDefault()
    if (!text.trim() || busy) return
    onSend(text.trim())
    setText('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) send(event)
  }
  return (
    <form onSubmit={send} className="flex items-end gap-2">
      <textarea
        className="textarea textarea-bordered flex-1 min-h-12"
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
        Send
      </button>
    </form>
  )
}

export default function ReportConversationPage() {
  const { runId = '' } = useParams()
  const report = useIssueReport(runId)
  const answer = useAnswerIssueReport(runId)
  const discard = useDiscardIssueReport(runId)

  const breadcrumbs = [
    { label: 'Ideas & issues', to: '/ideas-and-issues' },
    { label: 'Conversation' },
  ]
  if (report.isLoading) return <LoadingIndicator centered />
  const run = report.data
  if (!run) {
    return (
      <EmptyState
        icon={ChatBubbleLeftEllipsisIcon}
        message="Conversation not found"
        description="It may belong to someone else, or the link is wrong."
      />
    )
  }

  const pending = run.interrupts.find(i => i.status === 'pending')
  const thinking = run.status === 'queued' || run.status === 'running' || answer.isPending
  const output = issueReportOutputSchema.safeParse(run.output)
  const busy = answer.isPending || discard.isPending

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Ideas & issues"
        breadcrumbs={breadcrumbs}
        actions={
          isRunActive(run.status) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => discard.mutate()}
            >
              Discard
            </button>
          )
        }
      />

      <div className="space-y-3">
        {conversationOf(run).map(item => (
          <Bubble key={item.id} item={item} />
        ))}
        {thinking && (
          <div className="chat chat-start">
            <div className="chat-bubble bg-base-200 text-base-content">
              <span className="loading loading-dots loading-sm" />
              <span className="sr-only">Thinking</span>
            </div>
          </div>
        )}
      </div>

      {!thinking && pending?.spec.kind === 'input' && (
        <Composer
          placeholder="Your answer"
          busy={busy}
          onSend={text => answer.mutate({ interruptId: pending.id, payload: { text } })}
        />
      )}

      {!thinking && pending?.spec.kind === 'choice' && (
        <div className="space-y-3">
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={busy}
            onClick={() =>
              answer.mutate({
                interruptId: pending.id,
                payload: { value: ISSUE_REPORT_FILE_CHOICE },
              })
            }
          >
            {pending.spec.options[0]?.label ?? 'Log it on GitHub'}
          </button>
          <Composer
            placeholder="Or tell me what to change"
            busy={busy}
            onSend={value => answer.mutate({ interruptId: pending.id, payload: { value } })}
          />
        </div>
      )}

      {run.status === 'succeeded' && output.success && output.data.issueUrl && (
        <div role="status" className="alert alert-success">
          <span>
            {output.data.outcome === 'commented' ? 'Added to ' : 'Logged as '}
            <a
              href={output.data.issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="link"
            >
              #{output.data.issueNumber} {output.data.title}
            </a>
            . Thanks — the developers will pick it up from there.
          </span>
        </div>
      )}
      {(run.status === 'cancelled' ||
        (run.status === 'succeeded' && output.success && output.data.outcome === 'discarded')) && (
        <div role="status" className="alert">
          Discarded — nothing was logged.
        </div>
      )}
      {run.status === 'failed' && (
        <div role="alert" className="alert alert-error">
          Something went wrong: {run.error ?? 'the assistant stopped.'}
        </div>
      )}
    </div>
  )
}
