/**
 * `analytics.refresh-facts` — rebuild ONE organisation's fact tables (D31).
 *
 * This exists because a route never runs long work and a fact rebuild is a full DELETE+INSERT per
 * table. `POST /api/analytics/facts/refresh` (and `rocketflare analytics refresh-facts` over it)
 * enqueues; this handler does it. The `:15` cron is still the normal path — this is the "I have
 * just changed something and want the numbers now" path that `pnpm web db:refresh-facts` used to
 * be before analytics left the kit and its scripts with it.
 *
 * **One tenant, always.** The payload carries the tenant the route resolved from the caller's auth
 * context; a job a tenant API key can enqueue must never rebuild somebody else's rows. The
 * cross-tenant rebuild is the cron, which has no request behind it.
 *
 * Handler contract (`.claude/rules/api.md`): everything is awaited, there is no `waitUntil` in a
 * consumer, a throw is retried with backoff and a return is an `ack`.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import type { ANALYTICS_REFRESH_FACTS_JOB } from '@rocketflare/shared/plugins/analytics/index'
import type { JobContext } from '../../../api/queues/jobs'
import { refreshAllFactTables, refreshFactTable } from '../services/fact-tables'

export async function handleAnalyticsRefreshFacts(
  job: JobOf<typeof ANALYTICS_REFRESH_FACTS_JOB>,
  { db, logger }: JobContext
): Promise<void> {
  const { tenantId, table } = job.payload
  if (table) {
    const result = await refreshFactTable(db, table, { tenantId, logger })
    if (result.errors.length > 0) throw new Error(result.errors[0]?.error ?? 'fact refresh failed')
    return
  }
  const summary = await refreshAllFactTables(db, { tenantId, logger })
  if (summary.failed > 0) {
    throw new Error(`fact refresh failed for ${summary.failed} table(s) in tenant ${tenantId}`)
  }
}
