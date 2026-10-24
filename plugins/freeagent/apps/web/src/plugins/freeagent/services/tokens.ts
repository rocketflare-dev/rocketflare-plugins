/**
 * The OAuth half: exchanging the approval code, refreshing, and handing the client a token.
 *
 * FreeAgent's token endpoint takes the app's credentials as HTTP Basic and a form body
 * (`grant_type=authorization_code|refresh_token`). Access tokens last an hour; refresh tokens about
 * twenty years, and a refresh answers a NEW refresh token, which replaces the stored one.
 *
 * Both tokens live on `freeagent_connections`, sealed (`sealSecret`), never plaintext and never in a
 * log line. The access token is cached there rather than in memory because every queue message may
 * land on a fresh isolate; it is refreshed when it has less than two minutes left, and the refresh
 * is SINGLE-FLIGHT per token source — a sync that fires twenty requests on a cold cache refreshes
 * once, which matters against FreeAgent's 15-refreshes-a-minute limit.
 *
 * `invalid_grant` on refresh means the approval was revoked (or the token is from another
 * environment): the connection is marked `needs_reconnect` with the reason, the tools disappear,
 * the cron stops enqueueing it, and Settings asks an admin to reconnect.
 */
import type { FreeAgentEnvironment } from '@rocketflare/shared/plugins/freeagent/index'
import { and, eq } from 'drizzle-orm'
import type { Database, PluginConfig } from '@/plugins/api'
import { openSecret, sealSecret } from '@/plugins/api'
import { type FreeAgentConnectionRow, freeagentConnections } from '../db/schema'
import type { AccessTokenSource } from './client'
import { FREEAGENT_HOSTS, type FreeAgentAppCredentials, type FreeAgentDeps } from './env'
import { FreeAgentError, freeagentErrorMessage } from './errors'

/** Refresh when a cached token has less than this left. */
export const REFRESH_MARGIN_MS = 2 * 60_000

export interface TokenSet {
  accessToken: string
  /** Absent when FreeAgent did not rotate it; keep the one we have. */
  refreshToken: string | null
  expiresAt: Date
}

/** Base64 of `id:secret` without relying on Node's `Buffer`. */
function basicAuth(credentials: FreeAgentAppCredentials): string {
  const raw = `${credentials.clientId}:${credentials.clientSecret}`
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `Basic ${btoa(binary)}`
}

/** One call to `/v2/token_endpoint`. Never logs or echoes what it sent. */
async function tokenRequest(
  environment: FreeAgentEnvironment,
  credentials: FreeAgentAppCredentials,
  form: Record<string, string>,
  deps: FreeAgentDeps,
  now: Date
): Promise<TokenSet> {
  let response: Response
  try {
    response = await deps.fetch(`${FREEAGENT_HOSTS[environment]}/v2/token_endpoint`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(credentials),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    })
  } catch (err) {
    throw new FreeAgentError(
      'network',
      `FreeAgent's token endpoint did not answer: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    if (response.status === 429) {
      throw new FreeAgentError('rate_limited', 'Too many token refreshes; try again shortly', {
        status: 429,
      })
    }
    if (body?.error === 'invalid_grant') {
      throw new FreeAgentError(
        'invalid_grant',
        'FreeAgent no longer accepts this approval — reconnect to FreeAgent',
        { status: response.status }
      )
    }
    if (body?.error === 'invalid_client') {
      throw new FreeAgentError(
        'not_configured',
        'FreeAgent refused the app credentials — check FREEAGENT_CLIENT_ID and FREEAGENT_CLIENT_SECRET',
        { status: response.status }
      )
    }
    throw new FreeAgentError(
      response.status >= 500 ? 'upstream' : 'bad_response',
      freeagentErrorMessage(body) ?? `FreeAgent's token endpoint answered ${response.status}`,
      { status: response.status }
    )
  }
  const accessToken = body?.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new FreeAgentError('bad_response', "FreeAgent's token answer has no access token")
  }
  const expiresIn = Number(body?.expires_in)
  return {
    accessToken,
    refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : null,
    // An absent or odd lifetime is treated as FreeAgent's documented hour.
    expiresAt: new Date(now.getTime() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000),
  }
}

export function exchangeCode(
  environment: FreeAgentEnvironment,
  credentials: FreeAgentAppCredentials,
  input: { code: string; redirectUri: string },
  deps: FreeAgentDeps,
  now = new Date()
): Promise<TokenSet> {
  return tokenRequest(
    environment,
    credentials,
    { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri },
    deps,
    now
  )
}

export function refreshTokens(
  environment: FreeAgentEnvironment,
  credentials: FreeAgentAppCredentials,
  refreshToken: string,
  deps: FreeAgentDeps,
  now = new Date()
): Promise<TokenSet> {
  return tokenRequest(
    environment,
    credentials,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    deps,
    now
  )
}

/** Mark the connection as needing an admin, with the reason Settings shows. */
export async function markNeedsReconnect(
  db: Database,
  connection: Pick<FreeAgentConnectionRow, 'id' | 'tenantId'>,
  reason: string
): Promise<void> {
  await db
    .update(freeagentConnections)
    .set({
      status: 'needs_reconnect',
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
      lastError: reason,
      lastErrorAt: new Date(),
    })
    .where(
      and(
        eq(freeagentConnections.id, connection.id),
        eq(freeagentConnections.tenantId, connection.tenantId)
      )
    )
}

/**
 * A token source for one connection row: the cached access token while it has more than two
 * minutes left, otherwise ONE refresh shared by every caller waiting on it. The row object is
 * updated in place so later calls on the same source see the new token without a re-read.
 */
export function connectionTokenSource(
  db: Database,
  config: PluginConfig,
  connection: FreeAgentConnectionRow,
  credentials: FreeAgentAppCredentials,
  deps: FreeAgentDeps,
  now: () => Date = () => new Date()
): AccessTokenSource {
  let inFlight: Promise<string> | null = null

  const refresh = async (): Promise<string> => {
    const environment = connection.environment as FreeAgentEnvironment
    let tokens: TokenSet
    try {
      tokens = await refreshTokens(
        environment,
        credentials,
        await openSecret(config, connection.refreshTokenEnc),
        deps,
        now()
      )
    } catch (err) {
      if (err instanceof FreeAgentError && err.code === 'invalid_grant') {
        await markNeedsReconnect(db, connection, err.message)
        connection.status = 'needs_reconnect'
        throw new FreeAgentError('needs_reconnect', err.message, { status: err.status })
      }
      throw err
    }
    const accessTokenEnc = await sealSecret(config, tokens.accessToken)
    const refreshTokenEnc = tokens.refreshToken
      ? await sealSecret(config, tokens.refreshToken)
      : connection.refreshTokenEnc
    await db
      .update(freeagentConnections)
      .set({ accessTokenEnc, accessTokenExpiresAt: tokens.expiresAt, refreshTokenEnc })
      .where(
        and(
          eq(freeagentConnections.id, connection.id),
          eq(freeagentConnections.tenantId, connection.tenantId)
        )
      )
    connection.accessTokenEnc = accessTokenEnc
    connection.accessTokenExpiresAt = tokens.expiresAt
    connection.refreshTokenEnc = refreshTokenEnc
    return tokens.accessToken
  }

  return async ({ force }) => {
    if (connection.status !== 'connected') {
      throw new FreeAgentError('needs_reconnect', 'Reconnect to FreeAgent in Settings → FreeAgent')
    }
    if (
      !force &&
      connection.accessTokenEnc &&
      connection.accessTokenExpiresAt &&
      connection.accessTokenExpiresAt.getTime() - now().getTime() > REFRESH_MARGIN_MS
    ) {
      try {
        return await openSecret(config, connection.accessTokenEnc)
      } catch {
        // Sealed under a rotated key — refresh below rather than failing the call.
      }
    }
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }
}
