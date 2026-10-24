/**
 * The inbox plugin's tables (D31). Kit conventions throughout: `tenantRef()` first, `timestamps()`,
 * every index led by `tenant_id`, `tenantIsolation()` on each table.
 *
 * - `inbox_settings` — one row per organisation: the local part it receives on (UNIQUE across
 *   tenants — it is how an inbound message finds its organisation, so that one lookup is the
 *   plugin's only unscoped query), the sender allow-list and whether authentication is required.
 * - `inbox_messages` — one row per accepted message. The raw RFC 822 bytes live in R2 under
 *   `tenants/<id>/inbox/<message id>/raw.eml` (purged with the tenant by the kit); the row carries
 *   what the list and the consumers need. `message_id_header` is unique per tenant when present,
 *   so a message delivered twice (two forwarding rules, a retried SMTP hand-off) is stored once.
 * - `inbox_attachments` — one row per extracted part, cascading with its message, bytes in R2.
 */
import { sql } from 'drizzle-orm'
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

export const inboxSettings = pgTable(
  'inbox_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    enabled: boolean('enabled').notNull().default(false),
    localPart: text('local_part'),
    allowedSenders: text('allowed_senders').array().notNull().default(sql`'{}'::text[]`),
    requireAuthentication: boolean('require_authentication').notNull().default(true),
    /** Index each parsed message and its documents into the knowledge base (chat can search it). */
    ingestToKnowledge: boolean('ingest_to_knowledge').notNull().default(true),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('inbox_settings_tenant_uidx').on(table.tenantId),
    uniqueIndex('inbox_settings_local_part_uidx').on(table.localPart),
    tenantIsolation('inbox_settings'),
  ]
)

export const inboxMessages = pgTable(
  'inbox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    status: text('status').notNull().default('received'),
    kind: text('kind').notNull().default('message'),
    envelopeFrom: text('envelope_from').notNull(),
    fromAddress: text('from_address'),
    fromName: text('from_name'),
    toAddress: text('to_address').notNull(),
    subaddress: text('subaddress'),
    subject: text('subject'),
    messageIdHeader: text('message_id_header'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    rawKey: text('raw_key').notNull(),
    rawSize: integer('raw_size').notNull(),
    htmlKey: text('html_key'),
    textBody: text('text_body'),
    /** `{ spf, dkim, dmarc }` from `Authentication-Results`. */
    auth: jsonb('auth').notNull().default({}),
    /** `{ provider, code, url }` for a forwarding confirmation, else null. */
    confirmation: jsonb('confirmation'),
    attachmentCount: integer('attachment_count').notNull().default(0),
    error: text('error'),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    index('inbox_messages_tenant_received_idx').on(table.tenantId, table.receivedAt),
    index('inbox_messages_tenant_status_idx').on(table.tenantId, table.status),
    uniqueIndex('inbox_messages_tenant_message_id_uidx')
      .on(table.tenantId, table.messageIdHeader)
      .where(sql`${table.messageIdHeader} IS NOT NULL`),
    tenantIsolation('inbox_messages'),
  ]
)

export const inboxAttachments = pgTable(
  'inbox_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    messageId: uuid('message_id')
      .notNull()
      .references(() => inboxMessages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    inline: boolean('inline').notNull().default(false),
    ...timestamps(),
  },
  table => [
    index('inbox_attachments_tenant_message_idx').on(table.tenantId, table.messageId),
    uniqueIndex('inbox_attachments_message_sha_uidx').on(
      table.tenantId,
      table.messageId,
      table.sha256
    ),
    tenantIsolation('inbox_attachments'),
  ]
)

export type InboxSettingsRow = typeof inboxSettings.$inferSelect
export type InboxMessageRow = typeof inboxMessages.$inferSelect
export type NewInboxMessageRow = typeof inboxMessages.$inferInsert
export type InboxAttachmentRow = typeof inboxAttachments.$inferSelect
