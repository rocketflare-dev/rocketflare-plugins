/**
 * The hourly tick: reconcile each active installation with its organisation's members, then
 * enqueue every cursor that is due. Contributed through `ServerPlugin.scheduledTasks`; the cron
 * expression is also `plugin.json`'s `crons`, which `pnpm provision cloudflare <env>` writes into
 * both tomls.
 *
 * A `perTenantTask` (kit 0.48.0): the kit calls it once per organisation, and never for one where
 * an admin has turned `connectors` off (Settings → Domains). Every query here names that tenant,
 * and each job it enqueues re-reads its cursor under the tenant in its payload.
 *
 * A tenant whose `connectors` flag is off is skipped too (`ctx.features`). One installation failing
 * to reconcile is logged and does not cost the others their tick; one organisation failing is
 * logged by the kit and does not cost the others theirs.
 */
import { CONNECTORS_FLAG, CONNECTORS_SYNC_JOB } from '@rocketflare/shared/plugins/connectors/index'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { JobInput, TenantCronCtx } from '@/plugins/api'
import { perTenantTask } from '@/plugins/api'
import { connectorsConnections, connectorsInstallations, connectorsSyncCursors } from '../db/schema'
import { connectorProvider } from '../providers'
import { reconcileInstallation } from '../services/reconcile'

/**
 * Hourly, never faster: the tick reads Postgres even when nothing is installed, and a sub-hourly
 * read keeps a Neon compute from ever suspending. `:17` wakes the database in the same minutes as
 * the kit's `16 * * * *` sweep and analytics' `15 * * * *`, without sharing either expression.
 */
export const CONNECTORS_CRON = '17 * * * *'
/**
 * A cursor that finished less than this long ago is not due yet ("Sync now" a moment ago). Well
 * under the hour between ticks, so a cursor the last tick synced is due on this one even when its
 * job finished minutes after that tick.
 */
export const SYNC_INTERVAL_MS = 45 * 60_000

/** One organisation's tick: the cursors it enqueued. */
export async function enqueueDueSyncs(ctx: TenantCronCtx, now = new Date()): Promise<number> {
  const { tenantId } = ctx
  const installations = await ctx.db
    .select({ id: connectorsInstallations.id, provider: connectorsInstallations.provider })
    .from(connectorsInstallations)
    .where(
      and(
        eq(connectorsInstallations.tenantId, tenantId),
        eq(connectorsInstallations.status, 'active')
      )
    )
  if (installations.length === 0) return 0
  if (!(await ctx.features(tenantId)).includes(CONNECTORS_FLAG)) return 0

  const jobs: JobInput[] = []
  for (const installation of installations) {
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

export const enqueueDueSyncsTask = perTenantTask('connectors.enqueueDueSyncs', async ctx => {
  const queued = await enqueueDueSyncs(ctx)
  if (queued > 0) ctx.logger.info({ tenantId: ctx.tenantId, queued }, 'connectors.enqueueDueSyncs')
})
