/**
 * Inbox: what arrived, newest first, and one message beside it — sender, forwarding mailbox,
 * authentication verdicts, the text body and the attachments. A forwarding confirmation shows its
 * code and link at the top, because that is the only reason anybody opens one. A message
 * forwarded as an attachment links to the wrapper it came in ("Forwarded inside …"), and the
 * wrapper lists the emails split out of it ("Contains N forwarded emails").
 *
 * Bodies are shown as TEXT only. The HTML body and the raw message are downloads (served as
 * attachments by the API), never rendered here: they are markup a stranger wrote.
 */
import { ArrowUturnRightIcon, EnvelopeIcon, PaperClipIcon } from '@heroicons/react/24/outline'
import type {
  InboxMessage,
  InboxMessageLink,
  InboxMessageSummary,
} from '@rocketflare/shared/plugins/inbox/index'
import { useState } from 'react'
import {
  ConfirmModal,
  EmptyState,
  formatBytes,
  formatDateTime,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
  showToast,
  timeAgo,
  usePermissions,
} from '@/plugins/api/ui'
import {
  useDeleteInboxMessage,
  useInboxMessage,
  useInboxMessages,
  useReprocessInboxMessage,
} from '../hooks/useInbox'

const STATUS_BADGE: Record<InboxMessageSummary['status'], string> = {
  received: 'badge-ghost',
  parsed: 'badge-success',
  failed: 'badge-error',
}

export default function InboxPage() {
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const list = useInboxMessages({ page, pageSize: 25 })

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inbox"
        description="Email forwarded to this workspace's address. Settings → Inbox sets the address and who may send."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <SectionPanel flush>
          {list.isPending ? (
            <div className="p-4">
              <SkeletonRows rows={6} />
            </div>
          ) : list.isError || !list.data ? (
            <p className="p-4 text-sm text-error">The inbox could not be loaded.</p>
          ) : list.data.items.length === 0 ? (
            <EmptyState
              icon={EnvelopeIcon}
              message="Nothing has arrived yet"
              description="Forward a message to the inbox address and it will appear here."
            />
          ) : (
            <>
              <ul className="divide-y divide-base-300">
                {list.data.items.map(m => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(m.id)}
                      className={`w-full px-4 py-3 text-left hover:bg-base-200 ${selected === m.id ? 'bg-base-200' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {m.fromName || m.fromAddress || m.envelopeFrom}
                        </span>
                        {m.kind === 'confirmation' && (
                          <span className="badge badge-warning badge-sm">confirmation</span>
                        )}
                        <span className={`badge badge-sm ${STATUS_BADGE[m.status]}`}>
                          {m.status}
                        </span>
                        <span className="ml-auto shrink-0 text-xs opacity-60">
                          {timeAgo(m.receivedAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm opacity-80">
                        {m.parentMessageId && (
                          <ArrowUturnRightIcon
                            className="h-3 w-3 shrink-0"
                            aria-label="Forwarded as an attachment"
                          />
                        )}
                        <span className="truncate">{m.subject || '(no subject)'}</span>
                        {m.forwardedCount > 0 && (
                          <span className="badge badge-ghost badge-sm ml-auto shrink-0">
                            {m.forwardedCount} forwarded
                          </span>
                        )}
                        {m.attachmentCount > 0 && (
                          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs">
                            <PaperClipIcon className="h-3 w-3" />
                            {m.attachmentCount}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <PaginationControls
                className="p-3"
                pagination={list.data.pagination}
                onPageChange={setPage}
              />
            </>
          )}
        </SectionPanel>
        {selected ? (
          <MessageDetail id={selected} onSelect={setSelected} onDeleted={() => setSelected(null)} />
        ) : (
          <SectionPanel>
            <p className="text-sm opacity-70">Choose a message to read it.</p>
          </SectionPanel>
        )}
      </div>
    </div>
  )
}

function MessageDetail({
  id,
  onSelect,
  onDeleted,
}: {
  id: string
  onSelect: (id: string) => void
  onDeleted: () => void
}) {
  const message = useInboxMessage(id)
  if (message.isPending) {
    return (
      <SectionPanel>
        <SkeletonRows rows={8} />
      </SectionPanel>
    )
  }
  if (message.isError || !message.data) {
    return (
      <SectionPanel>
        <p className="text-sm text-error">This message could not be loaded.</p>
      </SectionPanel>
    )
  }
  return <MessageBody message={message.data} onSelect={onSelect} onDeleted={onDeleted} />
}

function Verdict({ label, value }: { label: string; value: string | null }) {
  const tone = value === 'pass' ? 'badge-success' : value ? 'badge-warning' : 'badge-ghost'
  return <span className={`badge badge-sm ${tone}`}>{`${label} ${value ?? '—'}`}</span>
}

function linkLabel(link: InboxMessageLink): string {
  const from = link.fromName || link.fromAddress
  return `${link.subject || '(no subject)'}${from ? ` — ${from}` : ''}`
}

function MessageBody({
  message,
  onSelect,
  onDeleted,
}: {
  message: InboxMessage
  onSelect: (id: string) => void
  onDeleted: () => void
}) {
  const attachments = message.attachments.filter(a => !a.expandedMessageId)
  const { can } = usePermissions()
  const reprocess = useReprocessInboxMessage()
  const remove = useDeleteInboxMessage()
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <SectionPanel
      title={message.subject || '(no subject)'}
      actions={
        <div className="flex gap-2">
          <a className="btn btn-ghost btn-xs" href={`/api/inbox/messages/${message.id}/raw`}>
            Download .eml
          </a>
          {message.hasHtmlBody && (
            <a className="btn btn-ghost btn-xs" href={`/api/inbox/messages/${message.id}/html`}>
              Download HTML
            </a>
          )}
          {can('update', 'InboxMessage') && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={reprocess.isPending}
              onClick={() =>
                reprocess.mutate(message.id, {
                  onSuccess: () => showToast('Reprocessing queued', 'success'),
                })
              }
            >
              Reprocess
            </button>
          )}
          {can('delete', 'InboxMessage') && (
            <button
              type="button"
              className="btn btn-ghost btn-xs text-error"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          )}
        </div>
      }
    >
      {message.confirmation && (
        <div role="alert" className="alert alert-warning mb-4">
          <div>
            <p className="font-medium">
              Forwarding confirmation
              {message.confirmation.provider !== 'other' &&
                ` from ${message.confirmation.provider}`}
            </p>
            {message.confirmation.code && (
              <p>
                Code: <code className="font-mono text-lg">{message.confirmation.code}</code>
              </p>
            )}
            {message.confirmation.url && (
              <a className="link" href={message.confirmation.url} target="_blank" rel="noreferrer">
                Open the confirmation link
              </a>
            )}
            {!message.confirmation.code && !message.confirmation.url && (
              <p>No code or link was found — read the body below.</p>
            )}
          </div>
        </div>
      )}
      {message.parent && (
        <p className="mb-3 flex items-center gap-1 text-sm">
          <ArrowUturnRightIcon className="h-4 w-4 opacity-60" />
          Forwarded inside{' '}
          <button
            type="button"
            className="link"
            onClick={() => message.parent && onSelect(message.parent.id)}
          >
            {linkLabel(message.parent)}
          </button>
        </p>
      )}
      <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-60">From</dt>
        <dd>
          {message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}
        </dd>
        <dt className="opacity-60">Forwarded by</dt>
        <dd>{message.forwardedBy ?? message.envelopeFrom}</dd>
        <dt className="opacity-60">To</dt>
        <dd>{message.toAddress}</dd>
        <dt className="opacity-60">Sent</dt>
        <dd>{message.sentAt ? formatDateTime(message.sentAt) : '—'}</dd>
        <dt className="opacity-60">Received</dt>
        <dd>{formatDateTime(message.receivedAt)}</dd>
        <dt className="opacity-60">Checks</dt>
        <dd className="flex flex-wrap items-center gap-1">
          <Verdict label="SPF" value={message.auth.spf} />
          <Verdict label="DKIM" value={message.auth.dkim} />
          <Verdict label="DMARC" value={message.auth.dmarc} />
          {message.parentMessageId && (
            <span className="text-xs opacity-60">(of the forward it came in)</span>
          )}
        </dd>
      </dl>
      {message.forwardedMessages.length > 0 && (
        <div className="mb-4">
          <p className="mb-1 text-sm font-medium">
            Contains {message.forwardedMessages.length} forwarded email
            {message.forwardedMessages.length === 1 ? '' : 's'}
          </p>
          <ul className="space-y-1">
            {message.forwardedMessages.map(f => (
              <li key={f.id} className="flex items-center gap-2 text-sm">
                <EnvelopeIcon className="h-4 w-4 opacity-60" />
                <button type="button" className="link text-left" onClick={() => onSelect(f.id)}>
                  {linkLabel(f)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {message.error && <p className="mb-4 text-sm text-error">{message.error}</p>}
      {attachments.length > 0 && (
        <ul className="mb-4 space-y-1">
          {attachments.map(a => (
            <li key={a.id} className="flex items-center gap-2 text-sm">
              <PaperClipIcon className="h-4 w-4 opacity-60" />
              <a className="link" href={`/api/inbox/attachments/${a.id}`}>
                {a.filename}
              </a>
              <span className="opacity-60">
                {a.contentType} · {formatBytes(a.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-base-200 p-3 text-sm">
        {message.textBody ?? (message.status === 'parsed' ? '(no text body)' : 'Not parsed yet.')}
      </pre>
      <ConfirmModal
        isOpen={confirmDelete}
        title="Delete this message?"
        message="The message, its attachments and the stored original are removed. This cannot be undone."
        confirmText="Delete"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          remove.mutate(message.id, {
            onSuccess: () => {
              setConfirmDelete(false)
              onDeleted()
            },
          })
        }
      />
    </SectionPanel>
  )
}
