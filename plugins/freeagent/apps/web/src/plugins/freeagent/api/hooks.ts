/**
 * `/api/hooks/freeagent` — this plugin's PUBLIC mount (no `authMiddleware`).
 *
 *   GET /callback   FreeAgent's approval redirect lands here with `code` and `state`
 *
 * What makes an unauthenticated route safe is that it trusts nothing the request says except what
 * it can VERIFY: `state`, signed by `POST /api/freeagent/connect` for one tenant and one admin, for
 * this purpose only, expiring in fifteen minutes (FreeAgent's own code lifetime). A missing,
 * tampered or expired state is a 401 and nothing else — no hint which part failed. Only after that
 * does the handler know which organisation it is acting for.
 *
 * Then: exchange the code (Basic auth with the operator's app), read `GET /v2/company` with the
 * new token, store both tokens SEALED, enqueue the first sync and send the admin back to
 * Settings → FreeAgent. The code and the tokens are never logged; a failure is logged by code.
 */
import {
  FREEAGENT_CONNECTION_ENTITY,
  FREEAGENT_SUBJECT,
  FREEAGENT_SYNC_JOB,
} from '@rocketflare/shared/plugins/freeagent/index'
import { z } from 'zod'
import type { PublicCtx } from '@/plugins/api'
import { createRouter, publicCtx, recordActivity, verifyState } from '@/plugins/api'
import { FreeAgentClient } from '../services/client'
import { saveConnection } from '../services/connection'
import {
  appCredentials,
  FREEAGENT_HOSTS,
  freeagentConfig,
  freeagentHttp,
  redirectUri,
  settingsReturnUrl,
} from '../services/env'
import { FreeAgentError } from '../services/errors'
import { mapCompany } from '../services/mapping'
import { exchangeCode } from '../services/tokens'

export const CONNECT_STATE_PURPOSE = 'freeagent.connect'
/** FreeAgent's approval code lives 15 minutes; the state need not outlive it. */
export const CONNECT_STATE_TTL_SECONDS = 15 * 60

export const connectStateSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
})

export const freeagentHooksRouter = createRouter()

freeagentHooksRouter.get('/callback', async c => {
  const ctx: PublicCtx = publicCtx(c)
  const query = new URL(c.req.url).searchParams
  // Parsed even though it is signed: a signature proves who wrote it, not what shape it has.
  const state = connectStateSchema.safeParse(
    await verifyState(ctx.config, CONNECT_STATE_PURPOSE, query.get('state') ?? '')
  )
  if (!state.success) ctx.unauthorized('Invalid or expired FreeAgent approval')
  const { tenantId, userId } = state.data
  const back = (outcome: { connected: true } | { error: string }) =>
    c.redirect(settingsReturnUrl(ctx.appUrl, outcome), 302)

  // The admin clicked "Deny" (or FreeAgent refused): FreeAgent sends `error`, no code.
  const denied = query.get('error')
  if (denied)
    return back({ error: denied === 'access_denied' ? 'access_denied' : 'approval_failed' })
  const code = query.get('code')
  if (!code) return back({ error: 'missing_code' })
  const credentials = appCredentials(ctx.config)
  if (!credentials) return back({ error: 'not_configured' })

  const environment = freeagentConfig(ctx.config).FREEAGENT_ENVIRONMENT
  const deps = freeagentHttp
  let connectionId: string
  let companyName: string | null
  try {
    const tokens = await exchangeCode(
      environment,
      credentials,
      { code, redirectUri: redirectUri(ctx.appUrl) },
      deps
    )
    const client = new FreeAgentClient({
      baseUrl: FREEAGENT_HOSTS[environment],
      accessToken: async () => tokens.accessToken,
      deps,
    })
    const company = mapCompany(await client.get('/v2/company'))
    companyName = company.companyName
    const row = await saveConnection(ctx, { tenantId, userId, environment, tokens, company })
    connectionId = row.id
  } catch (err) {
    const codeName = err instanceof FreeAgentError ? err.code : 'internal'
    ctx.logger.warn({ tenantId, code: codeName }, 'freeagent: completing the connection failed')
    return back({ error: codeName === 'invalid_grant' ? 'code_expired' : 'exchange_failed' })
  }

  await ctx.enqueue({ type: FREEAGENT_SYNC_JOB, payload: { tenantId, requestedBy: userId } })
  // Awaited rather than deferred: both are one cheap write, and the admin is waiting on a redirect.
  await recordActivity(ctx.db, {
    tenantId,
    userId,
    type: 'freeagent.connected',
    subjectType: FREEAGENT_SUBJECT,
    subjectId: connectionId,
    metadata: { companyName, environment },
  }).catch(() => {})
  await ctx.nudge(tenantId, FREEAGENT_CONNECTION_ENTITY).catch(() => {})
  return back({ connected: true })
})
