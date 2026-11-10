/**
 * The settings service: one row per organisation, read and written here and nowhere else, every
 * query filtered by the tenant id the caller was handed.
 *
 * The key is sealed on the way in (`sealSecret`) and opened only by `resolveReranker`, at the
 * moment a search is about to call the re-ranker.
 */
import type {
  GlobalSearchSettings,
  UpdateGlobalSearchSettings,
} from '@rocketflare/shared/plugins/global-search/index'
import { eq } from 'drizzle-orm'
import type { Database, PluginConfig } from '@/plugins/api'
import { openSecret, sealSecret } from '@/plugins/api'
import { type GlobalSearchSettingsRow, globalSearchSettings } from '../db/schema'
import { createRerankClient, type RerankClient } from './rerank'

export async function loadSettingsRow(
  db: Database,
  tenantId: string
): Promise<GlobalSearchSettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(globalSearchSettings)
    .where(eq(globalSearchSettings.tenantId, tenantId))
    .limit(1)
  return row
}

/** The public shape. `hasCredential`, never the key. */
export function toSettings(row: GlobalSearchSettingsRow | undefined): GlobalSearchSettings {
  return {
    rerankEnabled: row?.rerankEnabled ?? false,
    rerankBaseUrl: row?.rerankBaseUrl ?? null,
    rerankModel: row?.rerankModel ?? null,
    hasCredential: Boolean(row?.rerankApiKeyEnc),
    updatedAt: row?.updatedAt ?? null,
  }
}

export type KeyChange = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; apiKey: string }

export interface NextSettings {
  rerankEnabled: boolean
  rerankBaseUrl: string | null
  rerankModel: string | null
  key: KeyChange
  /** Whether everything a call needs (URL, model, key) will exist after the write. */
  complete: boolean
}

/**
 * The update rules, pure: an omitted key is kept, `null` clears it, and a base-URL change without a
 * new key clears it too, because a key belongs to one endpoint. Saving the organisation's FIRST
 * complete configuration turns re-ranking on unless the body says `rerankEnabled: false`.
 */
export function nextSettings(
  existing: GlobalSearchSettingsRow | undefined,
  body: UpdateGlobalSearchSettings
): NextSettings {
  const rerankBaseUrl =
    body.rerankBaseUrl === undefined ? (existing?.rerankBaseUrl ?? null) : body.rerankBaseUrl
  const rerankModel =
    body.rerankModel === undefined ? (existing?.rerankModel ?? null) : body.rerankModel
  const urlChanged = existing?.rerankBaseUrl != null && rerankBaseUrl !== existing.rerankBaseUrl
  let key: KeyChange
  if (typeof body.rerankApiKey === 'string') key = { kind: 'set', apiKey: body.rerankApiKey }
  else if (body.rerankApiKey === null || urlChanged) key = { kind: 'clear' }
  else key = { kind: 'keep' }
  const hasKey = key.kind === 'set' || (key.kind === 'keep' && Boolean(existing?.rerankApiKeyEnc))
  const complete = hasKey && Boolean(rerankBaseUrl) && Boolean(rerankModel)
  const wasComplete =
    Boolean(existing?.rerankApiKeyEnc) &&
    Boolean(existing?.rerankBaseUrl) &&
    Boolean(existing?.rerankModel)
  const firstComplete = complete && !wasComplete && key.kind === 'set'
  return {
    rerankEnabled: body.rerankEnabled ?? (firstComplete || (existing?.rerankEnabled ?? false)),
    rerankBaseUrl,
    rerankModel,
    key,
    complete,
  }
}

export async function saveSettings(
  db: Database,
  config: PluginConfig,
  tenantId: string,
  userId: string | null,
  next: NextSettings
): Promise<GlobalSearchSettingsRow> {
  const rerankApiKeyEnc =
    next.key.kind === 'set'
      ? await sealSecret(config, next.key.apiKey)
      : next.key.kind === 'clear'
        ? null
        : undefined
  const values = {
    rerankEnabled: next.rerankEnabled,
    rerankBaseUrl: next.rerankBaseUrl,
    rerankModel: next.rerankModel,
    updatedByUserId: userId,
    ...(rerankApiKeyEnc !== undefined && { rerankApiKeyEnc }),
  }
  const [row] = await db
    .insert(globalSearchSettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: globalSearchSettings.tenantId, set: values })
    .returning()
  if (!row) throw new Error('global_search_settings: upsert returned no row')
  return row
}

/**
 * This organisation's re-ranker, ready to call — or null when it has none switched on and
 * complete. The key is opened here, at the moment of use. Throws when the key cannot be opened
 * (no `OAUTH_ENCRYPTION_KEY`, a rotated key); the search treats that as a re-ranker error.
 */
export async function resolveReranker(
  db: Database,
  config: PluginConfig,
  tenantId: string,
  fetchImpl?: typeof fetch
): Promise<RerankClient | null> {
  const row = await loadSettingsRow(db, tenantId)
  if (!row?.rerankEnabled || !row.rerankApiKeyEnc || !row.rerankBaseUrl || !row.rerankModel) {
    return null
  }
  return createRerankClient({
    baseUrl: row.rerankBaseUrl,
    model: row.rerankModel,
    apiKey: await openSecret(config, row.rerankApiKeyEnc),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}
