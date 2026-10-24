/**
 * The freeagent plugin's tables (D31). Kit conventions throughout: `tenantRef()` first,
 * `timestamps()`, every index led by `tenant_id`, `tenantIsolation()` on each table.
 *
 * - `freeagent_connections` — one row per organisation (unique `tenant_id`): the environment it
 *   was made in, the refresh token and the cached access token (both SEALED with `sealSecret`,
 *   never plaintext), the company it approved, the sync claim and the last outcome.
 * - `freeagent_sync_state` — one `updated_since` cursor per (organisation, resource). Per-account
 *   resources carry the account in the key (`bank_transactions:<account url>`).
 * - The mirror: `freeagent_bank_accounts`, `freeagent_bank_transactions`, `freeagent_explanations`,
 *   `freeagent_categories`, `freeagent_contacts`, `freeagent_bills`, `freeagent_invoices`. Each row
 *   is keyed by its FreeAgent URL — FreeAgent identifies everything by URL, and so does every
 *   foreign reference here (`bank_account_url`, `category_url`, `contact_url`), which keeps an
 *   upsert one statement and lets a row arrive before the row it points at. Unique per tenant on
 *   `(tenant_id, url)`; the sync upserts on exactly that.
 *
 * Money is `numeric`, which drizzle returns as a STRING — never a float. FreeAgent's own
 * timestamps are kept as `fa_updated_at` beside the kit's `updated_at`, which is when WE wrote it.
 */
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../../../db/schema/kit'

/** Money: 2 dp is FreeAgent's, the extra headroom is for exchange-rate arithmetic upstream. */
const money = (name: string) => numeric(name, { precision: 18, scale: 2 })
/** A percentage such as `20` or `5.5`. */
const rate = (name: string) => numeric(name, { precision: 7, scale: 4 })

export const freeagentConnections = pgTable(
  'freeagent_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** `sandbox` | `production` — which API host the tokens belong to. */
    environment: text('environment').notNull(),
    /** `connected` | `needs_reconnect`. */
    status: text('status').notNull().default('connected'),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    accessTokenEnc: text('access_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    companyUrl: text('company_url'),
    companyName: text('company_name'),
    companyCurrency: text('company_currency'),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    /** The DB claim one sync holds — a second job (cron overlapping "Sync now") acks without work. */
    syncClaimedUntil: timestamp('sync_claimed_until', { withTimezone: true }),
    lastSyncStartedAt: timestamp('last_sync_started_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_connections_tenant_uidx').on(table.tenantId),
    tenantIsolation('freeagent_connections'),
  ]
)

export const freeagentSyncState = pgTable(
  'freeagent_sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** `contacts`, `bills`, `invoices`, `bank_transactions:<account url>`, … */
    resource: text('resource').notNull(),
    /** The next pass asks for `updated_since` this; null = never synced (a full pass). */
    updatedSince: timestamp('updated_since', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    itemsSynced: integer('items_synced').notNull().default(0),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_sync_state_resource_uidx').on(table.tenantId, table.resource),
    tenantIsolation('freeagent_sync_state'),
  ]
)

export const freeagentBankAccounts = pgTable(
  'freeagent_bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    url: text('url').notNull(),
    name: text('name').notNull(),
    /** `StandardBankAccount` | `CreditCardAccount` | `PaypalAccount`. */
    type: text('type'),
    currency: text('currency'),
    currentBalance: money('current_balance'),
    bankName: text('bank_name'),
    isPrimary: boolean('is_primary').notNull().default(false),
    status: text('status'),
    faUpdatedAt: timestamp('fa_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_bank_accounts_url_uidx').on(table.tenantId, table.url),
    tenantIsolation('freeagent_bank_accounts'),
  ]
)

export const freeagentBankTransactions = pgTable(
  'freeagent_bank_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    url: text('url').notNull(),
    bankAccountUrl: text('bank_account_url').notNull(),
    datedOn: date('dated_on', { mode: 'string' }).notNull(),
    amount: money('amount').notNull(),
    description: text('description'),
    fullDescription: text('full_description'),
    unexplainedAmount: money('unexplained_amount').notNull().default('0'),
    /** `unexplained_amount <> 0` — stored so the matcher's main query is one index range. */
    isUnexplained: boolean('is_unexplained').notNull().default(false),
    isManual: boolean('is_manual').notNull().default(false),
    faCreatedAt: timestamp('fa_created_at', { withTimezone: true }),
    faUpdatedAt: timestamp('fa_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_bank_transactions_url_uidx').on(table.tenantId, table.url),
    index('freeagent_bank_transactions_tenant_dated_idx').on(table.tenantId, table.datedOn),
    index('freeagent_bank_transactions_tenant_unexplained_idx').on(
      table.tenantId,
      table.isUnexplained,
      table.datedOn
    ),
    tenantIsolation('freeagent_bank_transactions'),
  ]
)

export const freeagentExplanations = pgTable(
  'freeagent_explanations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    url: text('url').notNull(),
    bankTransactionUrl: text('bank_transaction_url'),
    bankAccountUrl: text('bank_account_url'),
    categoryUrl: text('category_url'),
    /** FreeAgent's `type` / `entry_type`, e.g. `Payment`, `Business Entertaining`. */
    entryType: text('entry_type'),
    datedOn: date('dated_on', { mode: 'string' }),
    description: text('description'),
    grossValue: money('gross_value'),
    salesTaxRate: rate('sales_tax_rate'),
    salesTaxValue: money('sales_tax_value'),
    attachmentCount: integer('attachment_count').notNull().default(0),
    isDeletable: boolean('is_deletable'),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_explanations_url_uidx').on(table.tenantId, table.url),
    index('freeagent_explanations_tenant_transaction_idx').on(
      table.tenantId,
      table.bankTransactionUrl
    ),
    tenantIsolation('freeagent_explanations'),
  ]
)

export const freeagentCategories = pgTable(
  'freeagent_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    url: text('url').notNull(),
    description: text('description').notNull(),
    nominalCode: text('nominal_code'),
    /** `admin_expenses` | `cost_of_sales` | `income` | `general` — the key FreeAgent listed it under. */
    kind: text('kind').notNull(),
    groupDescription: text('group_description'),
    allowableForTax: boolean('allowable_for_tax'),
    taxReportingName: text('tax_reporting_name'),
    autoSalesTaxRate: text('auto_sales_tax_rate'),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_categories_url_uidx').on(table.tenantId, table.url),
    tenantIsolation('freeagent_categories'),
  ]
)

export const freeagentContacts = pgTable(
  'freeagent_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    url: text('url').notNull(),
    /** Organisation name, else "first last" — what every list shows. */
    displayName: text('display_name').notNull(),
    organisationName: text('organisation_name'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    status: text('status'),
    faUpdatedAt: timestamp('fa_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_contacts_url_uidx').on(table.tenantId, table.url),
    tenantIsolation('freeagent_contacts'),
  ]
)

export const freeagentBills = pgTable(
  'freeagent_bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    url: text('url').notNull(),
    contactUrl: text('contact_url'),
    reference: text('reference'),
    datedOn: date('dated_on', { mode: 'string' }),
    dueOn: date('due_on', { mode: 'string' }),
    paidOn: date('paid_on', { mode: 'string' }),
    status: text('status'),
    currency: text('currency'),
    totalValue: money('total_value'),
    netValue: money('net_value'),
    salesTaxValue: money('sales_tax_value'),
    paidValue: money('paid_value'),
    dueValue: money('due_value'),
    faUpdatedAt: timestamp('fa_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_bills_url_uidx').on(table.tenantId, table.url),
    index('freeagent_bills_tenant_dated_idx').on(table.tenantId, table.datedOn),
    tenantIsolation('freeagent_bills'),
  ]
)

export const freeagentInvoices = pgTable(
  'freeagent_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    url: text('url').notNull(),
    contactUrl: text('contact_url'),
    reference: text('reference'),
    datedOn: date('dated_on', { mode: 'string' }),
    dueOn: date('due_on', { mode: 'string' }),
    paidOn: date('paid_on', { mode: 'string' }),
    /** `Draft`, `Open`, `Overdue`, `Paid`, … as FreeAgent spells it. */
    status: text('status'),
    currency: text('currency'),
    netValue: money('net_value'),
    totalValue: money('total_value'),
    paidValue: money('paid_value'),
    dueValue: money('due_value'),
    faUpdatedAt: timestamp('fa_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('freeagent_invoices_url_uidx').on(table.tenantId, table.url),
    index('freeagent_invoices_tenant_dated_idx').on(table.tenantId, table.datedOn),
    tenantIsolation('freeagent_invoices'),
  ]
)

export type FreeAgentConnectionRow = typeof freeagentConnections.$inferSelect
export type FreeAgentSyncStateRow = typeof freeagentSyncState.$inferSelect
export type FreeAgentBankAccountRow = typeof freeagentBankAccounts.$inferSelect
export type FreeAgentBankTransactionRow = typeof freeagentBankTransactions.$inferSelect
export type NewFreeAgentBankTransactionRow = typeof freeagentBankTransactions.$inferInsert
export type FreeAgentExplanationRow = typeof freeagentExplanations.$inferSelect
export type NewFreeAgentExplanationRow = typeof freeagentExplanations.$inferInsert
export type FreeAgentCategoryRow = typeof freeagentCategories.$inferSelect
export type FreeAgentContactRow = typeof freeagentContacts.$inferSelect
export type FreeAgentBillRow = typeof freeagentBills.$inferSelect
export type FreeAgentInvoiceRow = typeof freeagentInvoices.$inferSelect
