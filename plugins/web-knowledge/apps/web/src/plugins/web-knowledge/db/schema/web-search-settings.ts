/**
 * `web_search_settings` — one row per organisation: which search provider it uses, its sealed API
 * key, and whether agents and chat get the web tools at all.
 *
 * The kit's schema convention, unchanged: `tenantRef()` first, `timestamps()`, `tenantIsolation()`
 * so the RLS policy exists whether or not `TENANT_SCOPE_MODE` is ever `enforce`. The tenant id is
 * UNIQUE because the settings are a singleton per organisation, and an upsert keys on it.
 *
 * `api_key_enc` holds `sealSecret()` output and nothing else. It is null until an admin saves a
 * key, and cleared when the provider changes without a new one (keys are per provider).
 */
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
// Relative, not `@/db/schema/kit`: drizzle-kit bundles this file itself and resolves no tsconfig path.
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../../../db/schema/kit'

export const webSearchSettings = pgTable(
  'web_search_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    enabled: boolean('enabled').notNull().default(false),
    /** One of `WEB_SEARCH_PROVIDERS`; validated by the contract, stored as text so a new provider is not a migration. */
    provider: text('provider').notNull().default('tavily'),
    apiKeyEnc: text('api_key_enc'),
    maxResults: integer('max_results').notNull().default(5),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('web_search_settings_tenant_idx').on(table.tenantId),
    tenantIsolation('web_search_settings'),
  ]
)

export type WebSearchSettingsRow = typeof webSearchSettings.$inferSelect
