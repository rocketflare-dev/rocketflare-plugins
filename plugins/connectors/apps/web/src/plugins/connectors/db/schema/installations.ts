/**
 * `connectors_installations` — one row per organisation per provider: the ADMIN's act of connecting
 * the organisation's Microsoft 365 / Google Workspace to this app.
 *
 * `status` moves `pending` (the consent URL was handed out) → `active` (the provider called back
 * with consent) → `error` (a token could not be minted: consent revoked, secret expired, BYO app
 * deleted). Only `active` installations are synced by the cron; "Sync now" retries an `error` one.
 *
 * `byo_secret_enc` holds `sealSecret()` output for an organisation that brought its own app, and
 * nothing else — never returned, answered as `hasCredential`. `settings` is provider-specific and
 * non-secret (a Google admin to impersonate for directory calls, say).
 */
import { sql } from 'drizzle-orm'
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
// Relative, not `@/db/schema/kit`: drizzle-kit bundles this file itself and resolves no tsconfig path.
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../../../db/schema/kit'

export const connectorsInstallations = pgTable(
  'connectors_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** A contributed provider's id (`m365`, `google-workspace`). Text, so a provider is not a migration. */
    provider: text('provider').notNull(),
    status: text('status', { enum: ['pending', 'active', 'error'] })
      .notNull()
      .default('pending'),
    appMode: text('app_mode', { enum: ['operator', 'byo'] })
      .notNull()
      .default('operator'),
    byoClientId: text('byo_client_id'),
    byoSecretEnc: text('byo_secret_enc'),
    /** The Entra tenant id / Google customer id — known once consent has come back. */
    externalTenantId: text('external_tenant_id'),
    displayName: text('display_name'),
    /** What the provider actually granted, read back from the last token (not what we asked for). */
    grantedScopes: text('granted_scopes').array().notNull().default(sql`'{}'::text[]`),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    installedByUserId: uuid('installed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('connectors_installations_tenant_provider_idx').on(table.tenantId, table.provider),
    tenantIsolation('connectors_installations'),
  ]
)

export type ConnectorsInstallationRow = typeof connectorsInstallations.$inferSelect
