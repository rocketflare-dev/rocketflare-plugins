/**
 * Reading synced calendar events — the one place the intra-tenant visibility rule is applied.
 *
 * Two predicates on every query, always both: the organisation (`tenant_id`) AND the reader. A
 * member reads `owner_user_id = themselves` and nothing else, whatever they asked for; only a
 * `manage Connector` reader (owner, admin) may widen to the organisation or name another person.
 * The route decides `mayReadAll` from the ability and hands it in — this module never sees a role.
 */
import {
  CALENDAR_EVENTS_MAX,
  type CalendarEvent,
  type CalendarEventListQuery,
  type CalendarEventListResponse,
} from '@rocketflare/shared/plugins/connectors/index'
import { and, asc, eq, gt, lt } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import {
  connectorsCalendarEvents,
  connectorsConnections,
  connectorsInstallations,
} from '../db/schema'

export async function listEvents(
  db: Database,
  reader: { tenantId: string; userId: string; mayReadAll: boolean },
  query: CalendarEventListQuery
): Promise<CalendarEventListResponse> {
  // A member's `scope=all` or `userId=` is not an error — it is simply their own calendar.
  const owner = reader.mayReadAll
    ? query.userId
      ? eq(connectorsCalendarEvents.ownerUserId, query.userId)
      : query.scope === 'all'
        ? undefined
        : eq(connectorsCalendarEvents.ownerUserId, reader.userId)
    : eq(connectorsCalendarEvents.ownerUserId, reader.userId)
  const rows = await db
    .select({ event: connectorsCalendarEvents, provider: connectorsInstallations.provider })
    .from(connectorsCalendarEvents)
    .innerJoin(
      connectorsConnections,
      eq(connectorsConnections.id, connectorsCalendarEvents.connectionId)
    )
    .innerJoin(
      connectorsInstallations,
      eq(connectorsInstallations.id, connectorsConnections.installationId)
    )
    .where(
      and(
        eq(connectorsCalendarEvents.tenantId, reader.tenantId),
        owner,
        // Overlap, not containment: an event that started yesterday and runs into the window shows.
        lt(connectorsCalendarEvents.startsAt, query.to),
        gt(connectorsCalendarEvents.endsAt, query.from)
      )
    )
    .orderBy(asc(connectorsCalendarEvents.startsAt), asc(connectorsCalendarEvents.id))
    .limit(CALENDAR_EVENTS_MAX + 1)
  const truncated = rows.length > CALENDAR_EVENTS_MAX
  return {
    items: rows
      .slice(0, CALENDAR_EVENTS_MAX)
      .map(({ event, provider }) => toEvent(event, provider)),
    truncated,
  }
}

function toEvent(
  row: typeof connectorsCalendarEvents.$inferSelect,
  provider: string
): CalendarEvent {
  return {
    id: row.id,
    provider,
    ownerUserId: row.ownerUserId,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isAllDay: row.isAllDay,
    location: row.location,
    organizerEmail: row.organizerEmail,
    organizerName: row.organizerName,
    attendees: row.attendees,
    webLink: row.webLink,
    isCancelled: row.isCancelled,
  }
}
