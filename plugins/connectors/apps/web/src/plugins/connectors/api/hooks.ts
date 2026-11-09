/**
 * `/api/hooks/connectors` — this plugin's PUBLIC mount (no `authMiddleware`).
 *
 *   GET /:provider/callback   the provider's admin-consent redirect lands here
 *
 * What makes an unauthenticated route safe is that it trusts nothing the request says except what
 * it can VERIFY: the `state` parameter, signed by `/api/connectors/installations` for one tenant,
 * one admin, one installation and one provider, and expiring. A missing, tampered, expired or
 * cross-provider state is answered with a redirect to the settings page and an error code — never
 * a stack, never a hint about which part failed beyond the code. The state says who started the
 * round trip: that the admin still holds `manage Connector` is read again here, and the
 * organisation on the other end comes from the provider's own proof, never from the query.
 *
 * Phase 2 adds the change-notification receivers (Graph `validationToken`, Google channels) here,
 * beside it, for the same reason: a vendor's server calls them with no session at all.
 */
import {
  CONNECTOR_SUBJECT,
  CONNECTORS_FLAG,
  CONNECTORS_INSTALLATIONS_ENTITY,
} from '@rocketflare/shared/plugins/connectors/index'
import type { PublicCtx } from '@/plugins/api'
import {
  createRouter,
  memberCan,
  publicCtx,
  recordActivity,
  signState,
  verifyState,
} from '@/plugins/api'
import { ConsentError, type ConsentResult, connectorProvider } from '../providers'
import {
  activateInstallation,
  credentialsFor,
  ExternalTenantInUseError,
  ExternalTenantMismatchError,
  loadInstallation,
} from '../services/installations'
import { defaultSyncDeps, enqueueCursors, redact } from '../services/sync'
import {
  CONSENT_STATE_PURPOSE,
  CONSENT_STATE_TTL_SECONDS,
  consentRedirectUri,
  consentStateSchema,
  settingsReturnUrl,
} from './consent'

export const connectorsHooksRouter = createRouter()

connectorsHooksRouter.get('/:provider/callback', async c => {
  const ctx: PublicCtx = publicCtx(c)
  const back = (outcome: { connected: string } | { error: string }) =>
    c.redirect(settingsReturnUrl(ctx.appUrl, outcome), 302)

  const providerId = c.req.param('provider')
  const query = new URL(c.req.url).searchParams
  // Parsed even though it is signed: a signature proves who wrote it, not what shape it has.
  const parsed = consentStateSchema.safeParse(
    await verifyState(ctx.config, CONSENT_STATE_PURPOSE, query.get('state') ?? '')
  )
  if (!parsed.success || parsed.data.provider !== providerId)
    return back({ error: 'invalid_state' })
  const state = parsed.data
  // The state proves who started this, and when. Whether they may still finish it is read now.
  const allowed = await memberCan(
    ctx,
    { tenantId: state.tenantId, userId: state.userId },
    'manage',
    CONNECTOR_SUBJECT
  )
  if (!allowed) return back({ error: 'invalid_state' })

  const provider = connectorProvider(providerId)
  if (!provider) return back({ error: 'provider_unknown' })
  if (!(await ctx.features(state.tenantId)).includes(CONNECTORS_FLAG)) {
    return back({ error: 'feature_disabled' })
  }
  const installation = await loadInstallation(ctx.db, state.tenantId, state.installationId)
  if (!installation || installation.provider !== providerId) {
    return back({ error: 'installation_missing' })
  }

  const credentials = await credentialsFor(ctx.config, provider, installation).catch(() => null)
  if (!credentials) return back({ error: 'consent_failed' })

  let result: ConsentResult
  try {
    result = await provider.completeConsent({
      query,
      credentials,
      redirectUri: consentRedirectUri(ctx.appUrl, providerId),
      fetch: defaultSyncDeps.fetch,
      continuation: state.continuation,
    })
  } catch (err) {
    const code = err instanceof ConsentError ? err.code : 'consent_failed'
    ctx.logger.warn({ provider: providerId, code }, 'connectors: consent was not granted')
    return back({ error: code })
  }

  if ('continueAt' in result) {
    const next = await signState(
      ctx.config,
      CONSENT_STATE_PURPOSE,
      { ...state, continuation: result.continuation },
      { ttlSeconds: CONSENT_STATE_TTL_SECONDS }
    )
    return c.redirect(result.continueAt(next), 302)
  }
  const consent = result

  try {
    const { cursorIds } = await activateInstallation(
      ctx.db,
      state.tenantId,
      installation.id,
      providerId,
      consent,
      provider.tokenPerSubject ? 'dwd' : 'app_only'
    )
    // The first directory pass starts now; calendars follow once it has matched members.
    await enqueueCursors(ctx, state.tenantId, cursorIds)
  } catch (err) {
    if (err instanceof ExternalTenantMismatchError)
      return back({ error: 'external_tenant_mismatch' })
    if (err instanceof ExternalTenantInUseError) return back({ error: 'external_tenant_in_use' })
    ctx.logger.error(
      { provider: providerId, err: redact(err instanceof Error ? err.message : String(err)) },
      'connectors: completing the installation failed'
    )
    return back({ error: 'consent_failed' })
  }

  // Awaited rather than deferred: both are one cheap write, and this response is a redirect the
  // admin is already waiting on.
  await recordActivity(ctx.db, {
    tenantId: state.tenantId,
    userId: state.userId,
    type: 'connectors.installation.connected',
    subjectType: 'Connector',
    subjectId: installation.id,
    metadata: { provider: providerId, externalTenantId: consent.externalTenantId },
  }).catch(() => {})
  await ctx.nudge(state.tenantId, CONNECTORS_INSTALLATIONS_ENTITY).catch(() => {})
  return back({ connected: providerId })
})
