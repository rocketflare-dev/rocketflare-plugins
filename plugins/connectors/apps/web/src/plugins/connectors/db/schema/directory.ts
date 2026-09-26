/**
 * The synced directory: `connectors_directory_users`, `connectors_directory_groups` and
 * `connectors_group_members`. All three cascade from their installation, so disconnecting a
 * provider is one DELETE and leaves nothing behind.
 *
 * `matched_user_id` links a directory person to a MEMBER of this organisation by lower-cased email
 * — never to an arbitrary user row: a person who is in the customer's directory but has never
 * joined the app matches nobody, and nobody's calendar is synced until they do.
 *
 * `sync_generation` is how a full resync removes what disappeared while a delta token was expired:
 * every row written during a pass carries the pass's generation, and when a FULL pass completes,
 * rows from an older generation are marked deleted. Memberships carry it for the same reason.
 * Removals seen in a delta are applied directly and need no generation.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../../../db/schema/kit'
import { connectorsInstallations } from './installations'

export const connectorsDirectoryUsers = pgTable(
  'connectors_directory_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => connectorsInstallations.id, { onDelete: 'cascade' }),
    /** The provider's immutable id (an Entra object id, a Google user id). Never the email. */
    externalId: text('external_id').notNull(),
    /** Lower-cased on write; the address matching and impersonation read. */
    email: text('email'),
    displayName: text('display_name'),
    jobTitle: text('job_title'),
    accountEnabled: boolean('account_enabled').notNull().default(true),
    matchedUserId: uuid('matched_user_id').references(() => users.id, { onDelete: 'set null' }),
    syncGeneration: integer('sync_generation').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('connectors_directory_users_ext_idx').on(table.installationId, table.externalId),
    index('connectors_directory_users_email_idx').on(table.tenantId, sql`lower(${table.email})`),
    tenantIsolation('connectors_directory_users'),
  ]
)

export const connectorsDirectoryGroups = pgTable(
  'connectors_directory_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => connectorsInstallations.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    email: text('email'),
    description: text('description'),
    syncGeneration: integer('sync_generation').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('connectors_directory_groups_ext_idx').on(table.installationId, table.externalId),
    tenantIsolation('connectors_directory_groups'),
  ]
)

/**
 * Membership by EXTERNAL ids on both sides, so a member can arrive before (or without) the user row
 * it names — delta streams for users and groups are independent and interleave freely.
 */
export const connectorsGroupMembers = pgTable(
  'connectors_group_members',
  {
    tenantId: tenantRef(tenants),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => connectorsInstallations.id, { onDelete: 'cascade' }),
    groupExternalId: text('group_external_id').notNull(),
    userExternalId: text('user_external_id').notNull(),
    syncGeneration: integer('sync_generation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ columns: [table.installationId, table.groupExternalId, table.userExternalId] }),
    tenantIsolation('connectors_group_members'),
  ]
)

export type ConnectorsDirectoryUserRow = typeof connectorsDirectoryUsers.$inferSelect
export type ConnectorsDirectoryGroupRow = typeof connectorsDirectoryGroups.$inferSelect
