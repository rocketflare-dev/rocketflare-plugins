/**
 * `connectors_calendar_events` — the synced events of every mailbox connection.
 *
 * **Intra-tenant visibility is the rule this table exists under.** An org-wide connection pulls
 * every synced employee's calendar into ONE kit tenant, so `tenant_id` isolation is necessary and
 * nowhere near sufficient: a row is readable by its `owner_user_id` (the matched kit member whose
 * mailbox it came from) and by `manage Connector` (owner, admin) — never by another member. Every
 * query in `services/events.ts` carries both predicates.
 *
 * Rows cascade from their connection, so a mailbox leaving the sync (the person left the
 * organisation, or no longer matches a member) takes its events with it.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../../../db/schema/kit'
import { connectorsConnections } from './connections'

export interface CalendarAttendee {
  email: string | null
  name: string | null
  response: string | null
}

export const connectorsCalendarEvents = pgTable(
  'connectors_calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connectorsConnections.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    title: text('title').notNull().default(''),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    isAllDay: boolean('is_all_day').notNull().default(false),
    location: text('location'),
    organizerEmail: text('organizer_email'),
    organizerName: text('organizer_name'),
    attendees: jsonb('attendees').$type<CalendarAttendee[]>().notNull().default([]),
    webLink: text('web_link'),
    isCancelled: boolean('is_cancelled').notNull().default(false),
    syncGeneration: integer('sync_generation').notNull().default(0),
    ...timestamps(),
  },
  table => [
    uniqueIndex('connectors_calendar_events_ext_idx').on(table.connectionId, table.externalId),
    index('connectors_calendar_events_owner_idx').on(
      table.tenantId,
      table.ownerUserId,
      table.startsAt
    ),
    tenantIsolation('connectors_calendar_events'),
  ]
)

export type ConnectorsCalendarEventRow = typeof connectorsCalendarEvents.$inferSelect
