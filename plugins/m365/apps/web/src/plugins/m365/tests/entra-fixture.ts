/**
 * A fake Microsoft Entra for the consent round trip: a token endpoint that answers with an
 * `id_token` signed by a key this fixture holds, and the JWKS that verifies it.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { FetchLike } from '@/plugins/connectors'

export const ENTRA_CLIENT_ID = 'operator-app'
export const ENTRA_NONCE = 'n-1'
/** Global Administrator's role template id. */
export const GLOBAL_ADMIN_ROLE = '62e90394-69f5-4237-9190-012177145e10'

export async function fakeEntra(
  tenant: string,
  claims: Record<string, unknown> = {},
  options: { signWith?: 'other-key' } = {}
) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const other = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const payload = {
    tid: tenant,
    wids: [GLOBAL_ADMIN_ROLE],
    nonce: ENTRA_NONCE,
    iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
    aud: ENTRA_CLIENT_ID,
    ...claims,
  } as Record<string, unknown>
  const { iss, aud, ...rest } = payload
  const signed = new SignJWT(rest)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(String(iss))
    .setAudience(aud as string)
    .setIssuedAt()
    .setExpirationTime('5m')
  const idToken = await signed.sign(options.signWith ? other.privateKey : privateKey)

  const tokenRequests: string[] = []
  const fetch: FetchLike = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      tokenRequests.push(url.pathname)
      return Response.json({ id_token: idToken, access_token: 'unused', expires_in: 3600 })
    }
    if (url.pathname.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [jwk] })
    throw new Error(`unexpected request to ${url.toString()}`)
  }
  return { fetch, tokenRequests }
}
