/**
 * The hourly fact-table rebuild (D19), contributed to the host's cron dispatcher through
 * `ServerPlugin.scheduledTasks` (D31). The cron EXPRESSION lives in `plugin.json` `crons` and is
 * added to `[triggers].crons` in both wrangler tomls by `pnpm provision cloudflare <env>` — a
 * plugin never edits a toml, so an install prints that step rather than doing it.
 *
 * This is the cross-tenant path, and it is the only one: it runs in the Worker's own `scheduled`
 * handler with no request behind it. The job a route can enqueue (`analytics.refresh-facts`) is
 * always one tenant.
 *
 * Per-tenant failures are collected by `refreshAllFactTables` and logged as a warning rather than
 * thrown — one bad tenant must not cost every other tenant its rebuild, and the rows are derived
 * data that the next run repairs.
 */
import type { ScheduledTask } from '../../../api/scheduled'
import { refreshAllFactTables } from '../services/fact-tables'

export const refreshFactTablesTask: ScheduledTask = {
  name: 'analytics.refreshFactTables',
  async run({ db, logger }) {
    const summary = await refreshAllFactTables(db, { logger })
    const log = summary.failed > 0 ? logger.warn.bind(logger) : logger.info.bind(logger)
    log(
      {
        durationMs: summary.durationMs,
        failed: summary.failed,
        tables: summary.results.map(r => ({
          table: r.table,
          tenants: r.tenants,
          rows: r.rows,
          errors: r.errors,
        })),
      },
      'analytics.refreshFactTables: fact tables rebuilt'
    )
  },
}
