/**
 * The hourly fact-table rebuild (D19), contributed to the host's cron dispatcher through
 * `ServerPlugin.scheduledTasks` (D31). The cron EXPRESSION lives in `plugin.json` `crons` and is
 * added to `[triggers].crons` in both wrangler tomls by `pnpm provision cloudflare <env>` — a
 * plugin never edits a toml, so an install prints that step rather than doing it.
 *
 * A `perTenantTask` (kit 0.48.0): the kit calls it once per organisation, and never for one where
 * an admin has turned `analytics` off (Settings → Domains), so each call rebuilds ONE tenant's
 * rows, as the job a route can enqueue (`analytics.refresh-facts`) does.
 *
 * Failures are collected by `refreshAllFactTables` and logged as a warning rather than thrown —
 * the rows are derived data that the next run repairs — and the kit runs every other
 * organisation whatever happens to one.
 */
import type { ScheduledTask, TenantCronCtx } from '@/plugins/api'
import { perTenantTask } from '@/plugins/api'
import { refreshAllFactTables } from '../services/fact-tables'

/** Rebuild every fact table for the organisation this turn of the cron is for. */
export async function refreshFactTables({ db, logger, tenantId }: TenantCronCtx): Promise<void> {
  const summary = await refreshAllFactTables(db, { tenantId, logger })
  if (summary.failed === 0) return
  logger.warn(
    {
      tenantId,
      durationMs: summary.durationMs,
      failed: summary.failed,
      tables: summary.results.map(r => ({ table: r.table, rows: r.rows, errors: r.errors })),
    },
    'analytics.refreshFactTables: some fact tables failed to rebuild'
  )
}

/** What `ServerPlugin.scheduledTasks` registers. */
export const refreshFactTablesTask: ScheduledTask = perTenantTask(
  'analytics.refreshFactTables',
  refreshFactTables
)
