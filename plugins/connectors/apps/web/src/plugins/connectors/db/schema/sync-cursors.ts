/**
 * `connectors_sync_cursors` — one per (connection, resource): where the next sync starts.
 *
 * `cursor` is opaque provider state — a Graph `@odata.nextLink`/`@odata.deltaLink`, a Google
 * `pageToken`/`syncToken`/`historyId`. `in_progress` says which: true means it is a PAGE link in
 * the middle of a pass, false means it is the delta token a finished pass left behind (or null:
 * never synced, or reset for a full resync).
 *
 * `claimed_until` is the concurrency control — a DB claim row, never an in-memory Map (the kit's
 * rule). A job claims its cursor with one conditional UPDATE, and a second job for the same cursor
 * (a double enqueue, a cron overlapping a "Sync now") sees the claim and acks without work. The
 * claim expires on its own, so a job that died mid-pass never wedges the cursor.
 *
 * `generation` counts FULL passes; `full_pass` says the current pass started from nothing, which
 * is what entitles its completion to sweep rows the pass did not see (see `directory.ts`).
 */
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantIsolation, tenantRef, tenants, timestamps } from '../../../../db/schema/kit'
import { connectorsConnections } from './connections'

export const connectorsSyncCursors = pgTable(
  'connectors_sync_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connectorsConnections.id, { onDelete: 'cascade' }),
    /** One of `CONNECTOR_RESOURCES`. */
    resource: text('resource').notNull(),
    cursor: text('cursor'),
    inProgress: boolean('in_progress').notNull().default(false),
    generation: integer('generation').notNull().default(0),
    fullPass: boolean('full_pass').notNull().default(false),
    /** When the current delta chain began — a provider may cap how long one may live. */
    fullSyncAt: timestamp('full_sync_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    itemsSynced: integer('items_synced').notNull().default(0),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    claimToken: uuid('claim_token'),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('connectors_sync_cursors_resource_idx').on(table.connectionId, table.resource),
    tenantIsolation('connectors_sync_cursors'),
  ]
)

export type ConnectorsSyncCursorRow = typeof connectorsSyncCursors.$inferSelect
