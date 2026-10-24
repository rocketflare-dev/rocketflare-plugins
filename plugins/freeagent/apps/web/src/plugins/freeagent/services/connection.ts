/**
 * The organisation's connection: read it, build a client for it, store a new one, remove it.
 *
 * `freeagentClientFor` is the front door every write and the sync use, and the one exported to
 * other plugins: it answers a client bound to THIS tenant's tokens and API host, or throws a
 * `FreeAgentError` saying exactly why it cannot (`not_configured`, `not_connected`,
 * `needs_reconnect`). Every query here names the tenant; the cron's fan-out is the plugin's only
 * cross-tenant read and lives in `api/scheduled.ts`.
 */
import type { FreeAgentEnvironment } from '@rocketflare/shared/plugins/freeagent/index'
import { eq } from 'drizzle-orm'
import type { Database, PluginConfig } from '@/plugins/api'
import { sealSecret } from '@/plugins/api'
import {
  type FreeAgentConnectionRow,
  freeagentBankAccounts,
  freeagentBankTransactions,
  freeagentBills,
  freeagentCategories,
  freeagentConnections,
  freeagentContacts,
  freeagentExplanations,
  freeagentInvoices,
  freeagentSyncState,
} from '../db/schema'
import { FreeAgentClient } from './client'
import { appCredentials, FREEAGENT_HOSTS, type FreeAgentDeps, freeagentHttp } from './env'
import { FreeAgentError } from './errors'
import type { TokenSet } from './tokens'
import { connectionTokenSource } from './tokens'

/** What every service here needs from whichever context called it (request, job, tool). */
export interface FreeAgentCtx {
  db: Database
  config: PluginConfig
  logger?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void }
}

export async function loadConnection(
  db: Database,
  tenantId: string
): Promise<FreeAgentConnectionRow | undefined> {
  const [row] = await db
    .select()
    .from(freeagentConnections)
    .where(eq(freeagentConnections.tenantId, tenantId))
    .limit(1)
  return row
}

/** True when tools and writes can work right now: a row, `connected`, and an app configured. */
export async function isUsable(ctx: FreeAgentCtx, tenantId: string): Promise<boolean> {
  if (!appCredentials(ctx.config)) return false
  const row = await loadConnection(ctx.db, tenantId)
  return row?.status === 'connected'
}

/** A client for an already-loaded connection row (the sync holds one from its claim). */
export function clientForConnection(
  ctx: FreeAgentCtx,
  connection: FreeAgentConnectionRow,
  deps: FreeAgentDeps = freeagentHttp
): FreeAgentClient {
  const credentials = appCredentials(ctx.config)
  if (!credentials) {
    throw new FreeAgentError(
      'not_configured',
      'FreeAgent is not set up on this deployment (FREEAGENT_CLIENT_ID / FREEAGENT_CLIENT_SECRET)'
    )
  }
  if (connection.status !== 'connected') {
    throw new FreeAgentError('needs_reconnect', 'Reconnect to FreeAgent in Settings → FreeAgent')
  }
  const environment = connection.environment as FreeAgentEnvironment
  return new FreeAgentClient({
    baseUrl: FREEAGENT_HOSTS[environment] ?? FREEAGENT_HOSTS.sandbox,
    accessToken: connectionTokenSource(ctx.db, ctx.config, connection, credentials, deps),
    deps,
  })
}

/**
 * A FreeAgent client for one organisation — the exported entry point for other plugins.
 * Throws `FreeAgentError` (`not_configured` | `not_connected` | `needs_reconnect`).
 */
export async function freeagentClientFor(
  ctx: FreeAgentCtx,
  tenantId: string,
  deps: FreeAgentDeps = freeagentHttp
): Promise<FreeAgentClient> {
  const connection = await loadConnection(ctx.db, tenantId)
  if (!connection) {
    throw new FreeAgentError('not_connected', 'This organisation has not connected FreeAgent')
  }
  return clientForConnection(ctx, connection, deps)
}

/** Every mirrored row and cursor for one tenant — the books we can no longer keep current. */
export async function clearMirror(db: Database, tenantId: string): Promise<void> {
  for (const table of [
    freeagentExplanations,
    freeagentBankTransactions,
    freeagentBankAccounts,
    freeagentCategories,
    freeagentContacts,
    freeagentBills,
    freeagentInvoices,
    freeagentSyncState,
  ]) {
    await db.delete(table).where(eq(table.tenantId, tenantId))
  }
}

/**
 * Store a fresh approval: tokens sealed, the company recorded, status `connected`. A reconnect to
 * a DIFFERENT company (another FreeAgent login) clears the old mirror first, so two companies'
 * books are never mixed under one organisation; a reconnect to the same one keeps its cursors.
 */
export async function saveConnection(
  ctx: FreeAgentCtx,
  input: {
    tenantId: string
    userId: string
    environment: FreeAgentEnvironment
    tokens: TokenSet
    company: {
      companyUrl: string | null
      companyName: string | null
      companyCurrency: string | null
    }
  }
): Promise<FreeAgentConnectionRow> {
  if (!input.tokens.refreshToken) {
    throw new FreeAgentError('bad_response', 'FreeAgent did not issue a refresh token')
  }
  const existing = await loadConnection(ctx.db, input.tenantId)
  if (
    existing &&
    (existing.environment !== input.environment ||
      (existing.companyUrl && existing.companyUrl !== input.company.companyUrl))
  ) {
    await clearMirror(ctx.db, input.tenantId)
  }
  const values = {
    environment: input.environment,
    status: 'connected',
    refreshTokenEnc: await sealSecret(ctx.config, input.tokens.refreshToken),
    accessTokenEnc: await sealSecret(ctx.config, input.tokens.accessToken),
    accessTokenExpiresAt: input.tokens.expiresAt,
    companyUrl: input.company.companyUrl,
    companyName: input.company.companyName,
    companyCurrency: input.company.companyCurrency,
    connectedByUserId: input.userId,
    connectedAt: new Date(),
    syncClaimedUntil: null,
    lastError: null,
    lastErrorAt: null,
  }
  const [row] = await ctx.db
    .insert(freeagentConnections)
    .values({ tenantId: input.tenantId, ...values })
    .onConflictDoUpdate({ target: freeagentConnections.tenantId, set: values })
    .returning()
  if (!row) throw new Error('freeagent_connections: upsert returned no row')
  return row
}

/** Disconnect: the tokens go, and with them the mirror and its cursors. */
export async function deleteConnection(db: Database, tenantId: string): Promise<boolean> {
  const deleted = await db
    .delete(freeagentConnections)
    .where(eq(freeagentConnections.tenantId, tenantId))
    .returning({ id: freeagentConnections.id })
  await clearMirror(db, tenantId)
  return deleted.length > 0
}
