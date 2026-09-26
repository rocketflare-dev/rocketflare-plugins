/**
 * Access tokens, minted by the provider and cached — sealed — by this plugin.
 *
 * A Graph app-only token reads every mailbox in the customer tenant for about an hour, so it is
 * cached ONCE, on the organisation's connection. A Google domain-wide-delegation token is bound to
 * one impersonated person, so it is cached on that person's connection. `tokenPerSubject` on the
 * provider says which; nothing else here differs.
 *
 * The cache is a Postgres column rather than KV or memory because it has to be shared across
 * isolates (every queue message may land on a fresh one) and it holds a credential — so it is
 * sealed like every other credential at rest, and it is refreshed a few minutes before expiry
 * rather than on the first 401.
 *
 * A failed mint is a `ConnectorAuthError` from the provider when the APP is refused (consent
 * revoked, secret expired); that is the caller's cue to mark the installation `error`.
 */
import { and, eq } from 'drizzle-orm'
import type { Database, PluginConfig } from '@/plugins/api'
import { openSecret, sealSecret } from '@/plugins/api'
import {
  type ConnectorsConnectionRow,
  type ConnectorsInstallationRow,
  connectorsConnections,
  connectorsInstallations,
} from '../db/schema'
import {
  ConnectorAuthError,
  type ConnectorProvider,
  type FetchLike,
  type SubjectView,
} from '../providers'
import { credentialsFor, toInstallationView } from './installations'

/** Re-mint when a cached token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000

export interface TokenSource {
  provider: ConnectorProvider
  installation: ConnectorsInstallationRow
  /** The connection whose row caches the token (the organisation's, for an app-only provider). */
  cacheOn: ConnectorsConnectionRow
  /** Who the token acts as; null for the organisation. */
  subject: SubjectView | null
}

/**
 * A token for this source: the cached one while it has life left, otherwise a fresh mint that
 * replaces the cache. Also records what the vendor says was granted, so the status view shows the
 * permissions the admin ACTUALLY consented to rather than the ones we asked for.
 */
export async function accessToken(
  db: Database,
  config: PluginConfig,
  source: TokenSource,
  fetch: FetchLike
): Promise<string> {
  const { cacheOn, installation, provider } = source
  if (
    cacheOn.accessTokenEnc &&
    cacheOn.accessTokenExpiresAt &&
    cacheOn.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS
  ) {
    try {
      return await openSecret(config, cacheOn.accessTokenEnc)
    } catch {
      // Sealed under a rotated key — mint a fresh one below rather than failing the sync.
    }
  }
  const credentials = await credentialsFor(config, provider, installation)
  if (!credentials) {
    throw new ConnectorAuthError(
      installation.appMode === 'byo'
        ? 'This organisation’s own app has no stored credentials — reconnect with its client id and secret'
        : `The ${provider.label} app is not configured on this deployment`,
      'connector_not_configured'
    )
  }
  const minted = await provider.mintToken({
    credentials,
    installation: toInstallationView(installation),
    subject: source.subject,
    fetch,
  })
  const accessTokenEnc = await sealSecret(config, minted.accessToken)
  await db
    .update(connectorsConnections)
    .set({ accessTokenEnc, accessTokenExpiresAt: minted.expiresAt, scopes: minted.scopes })
    .where(
      and(
        eq(connectorsConnections.id, cacheOn.id),
        eq(connectorsConnections.tenantId, cacheOn.tenantId)
      )
    )
  cacheOn.accessTokenEnc = accessTokenEnc
  cacheOn.accessTokenExpiresAt = minted.expiresAt
  if (source.subject === null && !sameScopes(installation.grantedScopes, minted.scopes)) {
    await db
      .update(connectorsInstallations)
      .set({ grantedScopes: minted.scopes })
      .where(
        and(
          eq(connectorsInstallations.id, installation.id),
          eq(connectorsInstallations.tenantId, installation.tenantId)
        )
      )
    installation.grantedScopes = minted.scopes
  }
  return minted.accessToken
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(s => set.has(s))
}
