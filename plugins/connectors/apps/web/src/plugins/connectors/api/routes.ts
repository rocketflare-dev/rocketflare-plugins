/**
 * `/api/connectors` — the organisation's connections (behind `authMiddleware` and the
 * `connectors` flag, like every plugin mount).
 *
 *   GET    /providers                   read Connector    — what installed provider plugins offer
 *   GET    /installations               read Connector    — status, counts, cursor progress
 *   POST   /installations               manage Connector  — start the admin-consent round trip
 *   DELETE /installations/:id           manage Connector  — disconnect and purge synced rows
 *   POST   /installations/:id/sync      manage Connector  — enqueue a sync now
 *   GET    /directory/users             manage Connector  — the synced directory (admins only)
 *   GET    /events?from=&to=            any member        — your own calendar; admins may widen
 *
 * The consent CALLBACK is not here: the provider redirects a browser to it with no guarantee of a
 * session cookie surviving the cross-site hop, so it lives on the public mount (`./hooks.ts`) and
 * trusts only the signed state this router minted.
 */
import {
  type CalendarEventListQuery,
  CONNECTOR_SUBJECT,
  CONNECTORS_INSTALLATIONS_ENTITY,
  CONNECTORS_SYNC_JOB,
  type ConnectorProviderInfo,
  calendarEventListQuerySchema,
  directoryUserListQuerySchema,
  type StartInstallationRequest,
  type SyncInstallationRequest,
  startInstallationRequestSchema,
  syncInstallationRequestSchema,
} from '@rocketflare/shared/plugins/connectors/index'
import { and, asc, count, eq } from 'drizzle-orm'
import type { RequestCtx } from '@/plugins/api'
import {
  createRouter,
  pageWindow,
  recordActivity,
  requestCtx,
  signState,
  validate,
} from '@/plugins/api'
import { connectorsDirectoryUsers } from '../db/schema'
import { connectorProvider, connectorProviders, providerResources } from '../providers'
import { listEvents } from '../services/events'
import {
  credentialsFor,
  deleteInstallation,
  listInstallations,
  loadInstallation,
  reactivateInstallation,
  upsertPendingInstallation,
} from '../services/installations'
import { installationCursorIds } from '../services/sync'
import { CONSENT_STATE_PURPOSE, CONSENT_STATE_TTL_SECONDS, consentRedirectUri } from './consent'

export const connectorsRouter = createRouter()

connectorsRouter.get('/providers', c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', CONNECTOR_SUBJECT)
  // Each audience is sent only what it can act on: the operator's steps need the deployment's
  // secrets, so they go to a global admin and nobody else. Whether the app is configured is a
  // boolean, never the credential.
  const isOperator = ctx.isGlobalAdmin
  const items: ConnectorProviderInfo[] = [...connectorProviders().values()].map(p => ({
    id: p.id,
    label: p.label,
    description: p.description,
    operatorConfigured: p.operatorCredentials(ctx.config) !== null,
    supportsByo: p.supportsByo,
    resources: providerResources(p),
    adminSteps: [...p.adminSteps],
    operatorSteps: isOperator ? [...p.operatorSteps] : [],
    permissions: [...p.permissions],
    docsUrl: p.docsUrl,
    redirectUri: consentRedirectUri(ctx.config.APP_URL, p.id),
  }))
  return c.json({ items, viewer: { isOperator } })
})

connectorsRouter.get('/installations', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', CONNECTOR_SUBJECT)
  return c.json({ items: await listInstallations(ctx.db, ctx.tenantId) })
})

connectorsRouter.post(
  '/installations',
  validate('json', startInstallationRequestSchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', CONNECTOR_SUBJECT)
    const body = ctx.valid<StartInstallationRequest>('json')
    const provider = connectorProvider(body.provider)
    if (!provider)
      ctx.notFound(`No installed plugin provides "${body.provider}"`, 'provider_unknown')
    if (body.appMode === 'byo' && !provider.supportsByo) {
      ctx.badRequest(`${provider.label} does not support bring-your-own apps`, 'byo_unsupported')
    }
    if (body.appMode === 'operator' && !provider.operatorCredentials(ctx.config)) {
      ctx.unavailable(
        `The ${provider.label} app is not configured on this deployment — ask the operator, or connect your own app`,
        'connector_not_configured'
      )
    }
    const row = await upsertPendingInstallation(ctx.db, ctx.config, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      provider: provider.id,
      appMode: body.appMode,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    })
    const credentials = await credentialsFor(ctx.config, provider, row)
    if (!credentials)
      ctx.unavailable('The app credentials could not be read', 'connector_not_configured')
    const state = await signState(
      ctx.config,
      CONSENT_STATE_PURPOSE,
      { tenantId: ctx.tenantId, userId: ctx.userId, provider: provider.id, installationId: row.id },
      { ttlSeconds: CONSENT_STATE_TTL_SECONDS }
    )
    const consentUrl = provider.consentUrl({
      credentials,
      redirectUri: consentRedirectUri(ctx.config.APP_URL, provider.id),
      state,
    })
    ctx.defer(() =>
      recordActivity(ctx.db, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        type: 'connectors.installation.started',
        subjectType: CONNECTOR_SUBJECT,
        subjectId: row.id,
        // What was chosen, never a credential.
        metadata: { provider: provider.id, appMode: body.appMode },
      })
    )
    ctx.nudge(CONNECTORS_INSTALLATIONS_ENTITY)
    return c.json({ installationId: row.id, consentUrl }, 201)
  }
)

connectorsRouter.delete('/installations/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', CONNECTOR_SUBJECT)
  const row = await deleteInstallation(ctx.db, ctx.tenantId, ctx.uuid('id'))
  if (!row) ctx.notFound('Installation not found')
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'connectors.installation.removed',
      subjectType: CONNECTOR_SUBJECT,
      subjectId: row.id,
      metadata: { provider: row.provider, externalTenantId: row.externalTenantId },
    })
  )
  ctx.nudge(CONNECTORS_INSTALLATIONS_ENTITY)
  return c.body(null, 204)
})

connectorsRouter.post(
  '/installations/:id/sync',
  validate('json', syncInstallationRequestSchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', CONNECTOR_SUBJECT)
    const body = ctx.valid<SyncInstallationRequest>('json')
    const row = await loadInstallation(ctx.db, ctx.tenantId, ctx.uuid('id'))
    if (!row) ctx.notFound('Installation not found')
    if (row.status === 'pending') {
      ctx.conflict('Finish connecting before syncing', 'installation_pending')
    }
    // "Sync now" is the retry for a broken installation: the next token mint proves it either way.
    if (row.status === 'error') await reactivateInstallation(ctx.db, ctx.tenantId, row.id)
    const ids = await installationCursorIds(ctx.db, ctx.tenantId, row.id, body.resource)
    if (ids.length > 0) {
      await ctx.enqueueMany(
        ids.map(cursorId => ({
          type: CONNECTORS_SYNC_JOB,
          payload: { tenantId: ctx.tenantId, cursorId },
        }))
      )
    }
    ctx.nudge(CONNECTORS_INSTALLATIONS_ENTITY)
    return c.json({ queued: ids.length }, 202)
  }
)

connectorsRouter.get(
  '/directory/users',
  validate('query', directoryUserListQuerySchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', CONNECTOR_SUBJECT)
    const query = ctx.valid<{ installationId: string; page: number; pageSize: number }>('query')
    const where = and(
      eq(connectorsDirectoryUsers.tenantId, ctx.tenantId),
      eq(connectorsDirectoryUsers.installationId, query.installationId)
    )
    const { limit, offset } = pageWindow(query)
    const rows = await ctx.db
      .select()
      .from(connectorsDirectoryUsers)
      .where(where)
      .orderBy(asc(connectorsDirectoryUsers.displayName), asc(connectorsDirectoryUsers.id))
      .limit(limit)
      .offset(offset)
    const [total] = await ctx.db.select({ n: count() }).from(connectorsDirectoryUsers).where(where)
    return c.json(
      ctx.page(
        rows.map(r => ({
          id: r.id,
          externalId: r.externalId,
          email: r.email,
          displayName: r.displayName,
          jobTitle: r.jobTitle,
          accountEnabled: r.accountEnabled,
          matchedUserId: r.matchedUserId,
          deletedAt: r.deletedAt,
        })),
        Number(total?.n ?? 0),
        query
      )
    )
  }
)

connectorsRouter.get('/events', validate('query', calendarEventListQuerySchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  const query = ctx.valid<CalendarEventListQuery>('query')
  return c.json(
    await listEvents(
      ctx.db,
      {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        mayReadAll: ctx.can('manage', CONNECTOR_SUBJECT),
      },
      query
    )
  )
})
