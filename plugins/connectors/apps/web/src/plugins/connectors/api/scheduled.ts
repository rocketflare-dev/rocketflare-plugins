/**
 * The quarter-hour tick: reconcile every active installation with its organisation's members, then
 * enqueue every cursor that is due. Contributed through `ServerPlugin.scheduledTasks`; the cron
 * expression is also `plugin.json`'s `crons`, which `pnpm provision cloudflare <env>` writes into
 * both tomls.
 *
 * This is the cross-tenant path and the only one — it runs in the Worker's `scheduled` handler with
 * no request behind it, and `CronCtx` deliberately has no `tenantId`. Every write it causes is
 * nevertheless per tenant: it reads (tenant, cursor) pairs and enqueues one job each, and each job
 * re-reads its cursor under the tenant in its payload.
 *
 * A tenant whose `connectors` flag is off is skipped whole (`ctx.features`, resolved per tenant off
 * the request path). One tenant failing to reconcile is logged and does not cost the others their
 * tick.
 */
import { CONNECTORS_FLAG, CONNECTORS_SYNC_JOB } from '@rocketflare/shared/plugins/connectors/index'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { CronCtx, JobInput, ScheduledTask } from '@/plugins/api'
import { cronCtx } from '@/plugins/api'
import { connectorsConnections, connectorsInstallations, connectorsSyncCursors } from '../db/schema'
import { connectorProvider } from '../providers'
import { reconcileInstallation } from '../services/reconcile'

export const CONNECTORS_CRON = '*/15 * * * *'
/** A cursor that finished less than this long ago is not due yet. */
export const SYNC_INTERVAL_MS = 15 * 60_000

export async function enqueueDueSyncs(ctx: CronCtx, now = new Date()): Promise<number> {
  const installations = await ctx.db
    .select({
      id: connectorsInstallations.id,
      tenantId: connectorsInstallations.tenantId,
      provider: connectorsInstallations.provider,
    })
    .from(connectorsInstallations)
    .where(eq(connectorsInstallations.status, 'active'))

  const enabled = new Map<string, boolean>()
  const jobs: JobInput[] = []
  for (const installation of installations) {
    const { tenantId } = installation
    if (!enabled.has(tenantId)) {
      enabled.set(tenantId, (await ctx.features(tenantId)).includes(CONNECTORS_FLAG))
    }
    if (!enabled.get(tenantId)) continue
    const provider = connectorProvider(installation.provider)
    if (!provider) continue
    try {
      await reconcileInstallation(ctx.db, tenantId, installation.id, provider)
    } catch (err) {
      ctx.logger.warn(
        { tenantId, installationId: installation.id, err: String(err) },
        'connectors.cron: reconcile failed'
      )
    }
    const due = await ctx.db
      .select({ id: connectorsSyncCursors.id })
      .from(connectorsSyncCursors)
      .innerJoin(
        connectorsConnections,
        eq(connectorsConnections.id, connectorsSyncCursors.connectionId)
      )
      .where(
        and(
          eq(connectorsSyncCursors.tenantId, tenantId),
          eq(connectorsConnections.installationId, installation.id),
          or(
            isNull(connectorsSyncCursors.claimedUntil),
            lt(connectorsSyncCursors.claimedUntil, now)
          ),
          or(
            isNull(connectorsSyncCursors.lastSyncedAt),
            lt(connectorsSyncCursors.lastSyncedAt, new Date(now.getTime() - SYNC_INTERVAL_MS)),
            // A pass that stopped mid-way (a lost continuation) resumes on the next tick.
            eq(connectorsSyncCursors.inProgress, true)
          )
        )
      )
    for (const cursor of due) {
      jobs.push({ type: CONNECTORS_SYNC_JOB, payload: { tenantId, cursorId: cursor.id } })
    }
  }
  // Queue batches are capped at 100 messages; `enqueueMany` chunks for us.
  if (jobs.length > 0) await ctx.enqueueMany(jobs)
  return jobs.length
}

export const enqueueDueSyncsTask: ScheduledTask = {
  name: 'connectors.enqueueDueSyncs',
  run: async raw => {
    const ctx = cronCtx(raw)
    const queued = await enqueueDueSyncs(ctx)
    ctx.logger.info({ queued }, 'connectors.enqueueDueSyncs')
  },
}
