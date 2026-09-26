/**
 * My calendar — the reader's own events, synced from their mailbox by the organisation's
 * connection. The proof, end to end, that the sync works and that visibility is per person: the
 * server answers only this reader's rows, so there is nothing here to hide client-side.
 *
 * A week at a time, starting today; "Previous" and "Next" move by a week.
 */
import type { CalendarEvent } from '@rocketflare/shared/plugins/connectors/index'
import { useMemo, useState } from 'react'
import { EmptyStateCard, formatDateTime, LoadingIndicator, PageHeader } from '@/plugins/api/ui'
import { useCalendarEvents } from '../hooks/useConnectors'

const WEEK_MS = 7 * 86_400_000

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export default function MyCalendarPage() {
  const [from, setFrom] = useState(startOfToday)
  const range = useMemo(() => ({ from, to: new Date(from.getTime() + WEEK_MS) }), [from])
  const events = useCalendarEvents(range)

  return (
    <div className="space-y-4">
      <PageHeader
        title="My calendar"
        description="Your events, synced from your organisation's connected calendar."
        actions={
          <div className="join">
            <button
              type="button"
              className="btn btn-sm join-item"
              onClick={() => setFrom(new Date(from.getTime() - WEEK_MS))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-sm join-item"
              onClick={() => setFrom(startOfToday())}
            >
              Today
            </button>
            <button
              type="button"
              className="btn btn-sm join-item"
              onClick={() => setFrom(new Date(from.getTime() + WEEK_MS))}
            >
              Next
            </button>
          </div>
        }
      />
      {events.isPending ? (
        <LoadingIndicator centered />
      ) : events.isError ? (
        <p className="text-sm text-error">Your calendar could not be loaded.</p>
      ) : events.data.items.length === 0 ? (
        <EmptyStateCard
          message="Nothing this week"
          description="If you expected events here, your organisation may not have connected its calendar yet, or your first sync is still running."
        />
      ) : (
        <ul className="space-y-2">
          {events.data.items.map(event => (
            <EventRow key={event.id} event={event} />
          ))}
          {events.data.truncated && (
            <li className="text-sm text-base-content/60">
              More events than fit — narrow the week.
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

function EventRow({ event }: { event: CalendarEvent }) {
  return (
    <li className={`card card-compact bg-base-100 border ${event.isCancelled ? 'opacity-60' : ''}`}>
      <div className="card-body">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className={`font-medium ${event.isCancelled ? 'line-through' : ''}`}>
            {event.webLink ? (
              <a className="link link-hover" href={event.webLink} target="_blank" rel="noreferrer">
                {event.title || '(no title)'}
              </a>
            ) : (
              event.title || '(no title)'
            )}
          </span>
          <span className="text-sm text-base-content/70">
            {event.isAllDay ? 'All day' : formatDateTime(event.startsAt)}
          </span>
        </div>
        {(event.location || event.organizerName || event.organizerEmail) && (
          <p className="text-sm text-base-content/70">
            {event.location}
            {event.location && (event.organizerName || event.organizerEmail) && ' · '}
            {(event.organizerName || event.organizerEmail) &&
              `organised by ${event.organizerName ?? event.organizerEmail}`}
          </p>
        )}
      </div>
    </li>
  )
}
