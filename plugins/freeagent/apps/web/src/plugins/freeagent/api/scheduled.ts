/**
 * The hourly tick: one `freeagent.sync` per connected organisation. Contributed through
 * `ServerPlugin.scheduledTasks`; the same expression is `plugin.json`'s `crons`, which
 * `pnpm provision cloudflare <env>` writes into both tomls.
 *
 * A `perTenantTask` (kit 0.48.0): the kit calls it once per organisation, and never for one where
 * an admin has turned `freeagent` off (Settings → Domains). It reads that organisation's
 * connection row, and the write it causes happens in a job that re-reads the connection under the
 * tenant in its payload.
 *
 * A tenant that needs reconnecting is skipped — no sync can succeed for it. Overlap with a sync
 * still running is harmless: the job's claim turns the second one into a no-op.
 */
import { FREEAGENT_SYNC_JOB } from '@rocketflare/shared/plugins/freeagent/index'
import { and, eq } from 'drizzle-orm'
import type { TenantCronCtx } from '@/plugins/api'
import { perTenantTask } from '@/plugins/api'
import { freeagentConnections } from '../db/schema'

/**
 * Hourly, never faster: the tick reads Postgres even when nobody is connected, and a sub-hourly
 * read keeps a Neon compute from ever suspending. `:18` wakes the database in the same minutes as
 * the kit's `16 * * * *` sweep and analytics' `15 * * * *`, without sharing either expression.
 */
export const FREEAGENT_CRON = '18 * * * *'

/** One organisation's tick: queue its sync when it is connected. Answers the jobs queued (0 or 1). */
export async function enqueueSyncs(ctx: TenantCronCtx): Promise<number> {
  const { tenantId } = ctx
  const [connected] = await ctx.db
    .select({ tenantId: freeagentConnections.tenantId })
    .from(freeagentConnections)
    .where(
      and(eq(freeagentConnections.tenantId, tenantId), eq(freeagentConnections.status, 'connected'))
    )
    .limit(1)
  if (!connected) return 0
  await ctx.enqueue({ type: FREEAGENT_SYNC_JOB, payload: { tenantId } })
  return 1
}

export const enqueueSyncsTask = perTenantTask('freeagent.enqueueSyncs', async ctx => {
  if ((await enqueueSyncs(ctx)) > 0) {
    ctx.logger.info({ tenantId: ctx.tenantId }, 'freeagent.enqueueSyncs')
  }
})
