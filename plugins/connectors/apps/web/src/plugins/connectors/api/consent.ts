/**
 * The admin-consent round trip, the half both routers share.
 *
 * The state that goes out through the provider and comes back on the callback is a SIGNED token
 * (`signState`, HMAC keyed from `OAUTH_ENCRYPTION_KEY`) naming the tenant, the admin and the
 * installation. It is the callback's only authority: the provider's redirect is a cross-site top-
 * level navigation, so there is no guarantee a session cookie comes with it, and a tenant id read
 * from anywhere else would let a forged callback attach a stranger's directory to this tenant.
 * The purpose string keeps a state minted for this flow from ever verifying in another.
 */
import { z } from 'zod'

export const CONSENT_STATE_PURPOSE = 'connectors.consent'
/** Admin consent is a few clicks, but it can involve a second admin signing in. */
export const CONSENT_STATE_TTL_SECONDS = 30 * 60

export const consentStateSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  provider: z.string().min(1),
  installationId: z.string().uuid(),
})
export type ConsentState = z.infer<typeof consentStateSchema>

/** The public mount's callback for one provider — what the operator registers as a redirect URI. */
export function consentRedirectUri(appUrl: string, provider: string): string {
  return new URL(`/api/hooks/connectors/${provider}/callback`, appUrl).toString()
}

/** Where the admin lands afterwards: the Connections tab, with the outcome in the query. */
export function settingsReturnUrl(
  appUrl: string,
  outcome: { connected: string } | { error: string }
): string {
  const url = new URL('/settings', appUrl)
  url.searchParams.set('tab', 'connections')
  if ('connected' in outcome) url.searchParams.set('connected', outcome.connected)
  else url.searchParams.set('connectError', outcome.error)
  return url.toString()
}
