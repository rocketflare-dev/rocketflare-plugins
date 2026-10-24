/**
 * The half-hourly tick: one `freeagent.sync` per connected organisation. Contributed through
 * `ServerPlugin.scheduledTasks`; the same expression is `plugin.json`'s `crons`, which
 * `pnpm provision cloudflare <env>` writes into both tomls.
 *
 * This is the plugin's one cross-tenant read: it runs in the Worker's `scheduled` handler with no
 * request behind it, reads only tenant ids, and every write it causes happens in a job that
 * re-reads its connection under the tenant in its payload. It needs no `unscopedAllowlist` entry:
 * the kit's scan sees the `tenantId` it selects, and the test refuses a stale one.
 *
 * A tenant that needs reconnecting is skipped — no sync can succeed for it. Overlap with a sync
 * still running is harmless: the job's claim turns the second one into a no-op.
 */
import { FREEAGENT_SYNC_JOB } from '@rocketflare/shared/plugins/freeagent/index'
import { eq } from 'drizzle-orm'
import type { CronCtx, JobInput, ScheduledTask } from '@/plugins/api'
import { cronCtx } from '@/plugins/api'
import { freeagentConnections } from '../db/schema'

export const FREEAGENT_CRON = '*/30 * * * *'

export async function enqueueSyncs(ctx: CronCtx): Promise<number> {
  const connected = await ctx.db
    .select({ tenantId: freeagentConnections.tenantId })
    .from(freeagentConnections)
    .where(eq(freeagentConnections.status, 'connected'))
  const jobs: JobInput[] = connected.map(row => ({
    type: FREEAGENT_SYNC_JOB,
    payload: { tenantId: row.tenantId },
  }))
  // Queue batches are capped at 100 messages; `enqueueMany` chunks for us.
  if (jobs.length > 0) await ctx.enqueueMany(jobs)
  return jobs.length
}

export const enqueueSyncsTask: ScheduledTask = {
  name: 'freeagent.enqueueSyncs',
  run: async raw => {
    const ctx = cronCtx(raw)
    const queued = await enqueueSyncs(ctx)
    ctx.logger.info({ queued }, 'freeagent.enqueueSyncs')
  },
}
