/**
 * Fact-table registry (D19, D31) — the ONE list that `refresh.ts`, `freshness.ts` and the `:15`
 * cron task (`api/scheduled.ts`) iterate. Adding a fact table = a schema file under
 * `db/schema/facts/`, a `queries/<name>.ts` SELECT builder, and one entry here. Every table
 * carries `tenant_id` (rebuilt per tenant) and `fact_refreshed_at` (the freshness watermark).
 *
 * `analyticsFactTables()` is a memoised FUNCTION rather than a const because its one entry names
 * the kit's `activity_events` as its source, which reaches this plugin through `kitTables()` — a
 * call that must not happen at module scope (see `../../kit-tables.ts`).
 */
import type { SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { tenantActivityDailyFacts } from '../../db/schema/facts'
import { contributedFactTables } from '../../extensions'
import { activityEventsTable } from '../../kit-tables'
import { tenantActivityDailySelect } from './queries/tenant-activity-daily'

export interface FactTableDefinition {
  /** Physical table name — also the key used by `GET /api/analytics/facts/status` and the CLI. */
  name: string
  /** Drizzle mirror; its column order is the INSERT's column list. */
  table: PgTable
  /** How often the cron rebuilds it; freshness flags `stale` past 2× this. */
  refreshIntervalMinutes: number
  /** Where the rows come from — `MAX(timestampColumn)` is the "newest source row" for freshness. */
  source: { name: string; table: PgTable; timestampColumn: PgColumn }
  /** The parameterised SELECT producing this tenant's rows, in `table` column order. */
  selectForTenant(tenantId: string): SQL
}

let memo: readonly FactTableDefinition[] | null = null

/** This plugin's own fact tables. Memoised: the source table is read once per isolate. */
export function analyticsFactTables(): readonly FactTableDefinition[] {
  if (memo) return memo
  const activityEvents = activityEventsTable()
  memo = [
    {
      name: 'analytics_tenant_activity_daily_facts',
      table: tenantActivityDailyFacts,
      refreshIntervalMinutes: 60,
      source: {
        name: 'activity_events',
        table: activityEvents,
        timestampColumn: activityEvents.createdAt,
      },
      selectForTenant: tenantActivityDailySelect,
    },
  ]
  return memo
}

/**
 * Every fact table this app has: this plugin's, plus every one another installed plugin
 * contributed through `analyticsExtensions({ factTables })` (D31 decision 6). A FUNCTION, not a
 * const, because reading the plugin barrel at module scope here would close a cycle;
 * `contributedFactTables` memoises, so the walk is paid once per isolate.
 */
export function factTables(): readonly FactTableDefinition[] {
  return [...analyticsFactTables(), ...contributedFactTables()]
}

export function getFactTable(name: string): FactTableDefinition {
  const all = factTables()
  const def = all.find(t => t.name === name)
  if (!def) {
    throw new Error(`Unknown fact table "${name}" (known: ${all.map(t => t.name).join(', ')})`)
  }
  return def
}
