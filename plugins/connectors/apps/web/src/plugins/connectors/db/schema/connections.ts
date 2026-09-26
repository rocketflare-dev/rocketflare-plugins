/**
 * `connectors_connections` — WHOSE data a set of cursors reads, and with which token.
 *
 * One model for all three usage models (D34):
 *
 * - **org-wide, app-only** (phase 1): every connection is `owner_type = 'tenant'`. One is the
 *   organisation itself (`subject = '*'`: directory users and groups); the rest are one per synced
 *   mailbox (`subject` = the directory user's external id, `directory_user_id` set).
 * - **per-user delegated** (phase 4): `owner_type = 'user'`, `owner_user_id` set, a sealed
 *   `refresh_token_enc` — the person connected their own account after the admin configured the app.
 * - **hybrid**: both kinds under one installation. A tenant-owned connection wins for sync; a
 *   user-owned one wins for anything that acts on that person's behalf.
 *
 * The access-token cache lives here, sealed: app-only providers (Graph client credentials) cache on
 * the organisation's `'*'` row; per-subject providers (Google domain-wide delegation) on each row.
 */
import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../../../db/schema/kit'
import { connectorsDirectoryUsers } from './directory'
import { connectorsInstallations } from './installations'

/** The subject of the organisation-level connection: the directory itself, not a person. */
export const CONNECTORS_ORGANISATION_SUBJECT = '*'

export const connectorsConnections = pgTable(
  'connectors_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => connectorsInstallations.id, { onDelete: 'cascade' }),
    ownerType: text('owner_type', { enum: ['tenant', 'user'] })
      .notNull()
      .default('tenant'),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    authKind: text('auth_kind', { enum: ['app_only', 'dwd', 'delegated'] }).notNull(),
    /** `'*'` for the organisation; otherwise the directory user's external id. */
    subject: text('subject').notNull(),
    /** The mailbox's directory row. Deleting it (disconnect, full-sync sweep) removes the mailbox. */
    directoryUserId: uuid('directory_user_id').references(() => connectorsDirectoryUsers.id, {
      onDelete: 'cascade',
    }),
    status: text('status', { enum: ['active', 'error'] })
      .notNull()
      .default('active'),
    accessTokenEnc: text('access_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    /** Phase 4 (delegated) only. */
    refreshTokenEnc: text('refresh_token_enc'),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    lastError: text('last_error'),
    ...timestamps(),
  },
  table => [
    uniqueIndex('connectors_connections_subject_idx').on(
      table.installationId,
      table.ownerType,
      table.subject
    ),
    tenantIsolation('connectors_connections'),
  ]
)

export type ConnectorsConnectionRow = typeof connectorsConnections.$inferSelect
