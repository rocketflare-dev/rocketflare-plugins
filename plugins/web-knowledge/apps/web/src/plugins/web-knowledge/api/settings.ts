/**
 * The settings service: one row per organisation, read and written here and nowhere else, every
 * query filtered by the tenant id the caller was handed.
 *
 * The key is sealed on the way in and opened only by `openKey`, which a tool calls at the moment it
 * makes the outbound request — never the `agentTools` builder, which runs on every chat turn
 * whether or not a tool is called.
 */
import {
  type UpdateWebSearchSettings,
  WEB_SEARCH_DEFAULT_RESULTS,
  type WebSearchProvider,
  type WebSearchSettings,
  webSearchProviderSchema,
} from '@rocketflare/shared/plugins/web-knowledge/index'
import { eq } from 'drizzle-orm'
import type { Database, PluginConfig } from '@/plugins/api'
import { openSecret, sealSecret } from '@/plugins/api'
import { type WebSearchSettingsRow, webSearchSettings } from '../db/schema'

/** What a settings row means once it has been read: the fields a tool needs, key still sealed. */
export interface EnabledSearch {
  provider: WebSearchProvider
  maxResults: number
  apiKeyEnc: string
}

export async function loadRow(
  db: Database,
  tenantId: string
): Promise<WebSearchSettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(webSearchSettings)
    .where(eq(webSearchSettings.tenantId, tenantId))
    .limit(1)
  return row
}

/** A stored provider outside the list (a provider removed in a later release) reads as the default. */
function providerOf(row: WebSearchSettingsRow | undefined): WebSearchProvider {
  const parsed = webSearchProviderSchema.safeParse(row?.provider)
  return parsed.success ? parsed.data : 'tavily'
}

/** The public shape. `hasCredential`, never the key. */
export function toSettings(row: WebSearchSettingsRow | undefined): WebSearchSettings {
  return {
    enabled: row?.enabled ?? false,
    provider: providerOf(row),
    hasCredential: Boolean(row?.apiKeyEnc),
    maxResults: row?.maxResults ?? WEB_SEARCH_DEFAULT_RESULTS,
    updatedAt: row?.updatedAt ?? null,
  }
}

/**
 * Enabled AND holding a key, or null. This is what decides whether a tenant's runs get the tools
 * at all, so it is deliberately strict: a row switched on with no key offers nothing.
 */
export async function loadEnabledSearch(
  db: Database,
  tenantId: string
): Promise<EnabledSearch | null> {
  const row = await loadRow(db, tenantId)
  if (!row?.enabled || !row.apiKeyEnc) return null
  const provider = webSearchProviderSchema.safeParse(row.provider)
  if (!provider.success) return null
  return { provider: provider.data, maxResults: row.maxResults, apiKeyEnc: row.apiKeyEnc }
}

/** `keep` the sealed key, `clear` it, or seal this new plaintext. */
export type KeyChange = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; apiKey: string }

export interface NextSettings {
  enabled: boolean
  provider: WebSearchProvider
  maxResults: number
  key: KeyChange
  /** Whether a key will exist after the write — what "enabled needs a key" is checked against. */
  hasKey: boolean
}

/**
 * The update rules, as a pure function so they are tested without a database:
 * an omitted key is kept, `null` clears it, and a provider change without a new key clears it too,
 * because a key belongs to one provider.
 */
export function nextSettings(
  existing: WebSearchSettingsRow | undefined,
  body: UpdateWebSearchSettings
): NextSettings {
  const currentProvider = providerOf(existing)
  const provider = body.provider ?? currentProvider
  const providerChanged = existing !== undefined && provider !== currentProvider
  let key: KeyChange
  if (typeof body.apiKey === 'string') key = { kind: 'set', apiKey: body.apiKey }
  else if (body.apiKey === null || providerChanged) key = { kind: 'clear' }
  else key = { kind: 'keep' }
  const hasKey = key.kind === 'set' || (key.kind === 'keep' && Boolean(existing?.apiKeyEnc))
  return {
    enabled: body.enabled ?? existing?.enabled ?? false,
    provider,
    maxResults: body.maxResults ?? existing?.maxResults ?? WEB_SEARCH_DEFAULT_RESULTS,
    key,
    hasKey,
  }
}

export async function saveSettings(
  db: Database,
  config: PluginConfig,
  tenantId: string,
  userId: string | null,
  next: NextSettings
): Promise<WebSearchSettingsRow> {
  const apiKeyEnc =
    next.key.kind === 'set'
      ? await sealSecret(config, next.key.apiKey)
      : next.key.kind === 'clear'
        ? null
        : undefined
  const values = {
    enabled: next.enabled,
    provider: next.provider,
    maxResults: next.maxResults,
    updatedByUserId: userId,
    ...(apiKeyEnc !== undefined && { apiKeyEnc }),
  }
  const [row] = await db
    .insert(webSearchSettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: webSearchSettings.tenantId, set: values })
    .returning()
  if (!row) throw new Error('web_search_settings: upsert returned no row')
  return row
}

/** The plaintext key, at the moment of use. */
export function openKey(config: PluginConfig, apiKeyEnc: string): Promise<string> {
  return openSecret(config, apiKeyEnc)
}
