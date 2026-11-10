/**
 * `global_search_settings` — one row per organisation: its own re-ranker (a Cohere-style
 * `POST {base}/rerank` endpoint), the model, the sealed key, and whether search uses it.
 *
 * The kit's schema convention, unchanged: `tenantRef()` first, `timestamps()`, `tenantIsolation()`
 * so the RLS policy exists whether or not `TENANT_SCOPE_MODE` is ever `enforce`. The tenant id is
 * UNIQUE because the settings are a singleton per organisation, and an upsert keys on it.
 *
 * `rerank_api_key_enc` holds `sealSecret()` output and nothing else. It is cleared when the base
 * URL changes without a new key (a key belongs to one endpoint).
 */
import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
// Relative, not `@/db/schema/kit`: drizzle-kit bundles this file itself and resolves no tsconfig path.
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../../../db/schema/kit'

export const globalSearchSettings = pgTable(
  'global_search_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    rerankEnabled: boolean('rerank_enabled').notNull().default(false),
    rerankBaseUrl: text('rerank_base_url'),
    rerankModel: text('rerank_model'),
    rerankApiKeyEnc: text('rerank_api_key_enc'),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('global_search_settings_tenant_idx').on(table.tenantId),
    tenantIsolation('global_search_settings'),
  ]
)

export type GlobalSearchSettingsRow = typeof globalSearchSettings.$inferSelect
