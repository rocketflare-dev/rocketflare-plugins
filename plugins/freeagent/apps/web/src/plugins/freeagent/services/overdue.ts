/**
 * "Overdue" and "outstanding" as SQL, over a bill or invoice table — the same rule `isOverdue`
 * (`./mapping`) applies in TypeScript, so the page, the tools and the cubes agree on what the word
 * means: something is still owed, and (for overdue) its due date has passed. FreeAgent's own
 * `Overdue` status counts whatever the dates say, because it is FreeAgent's call.
 */
import { and, eq, gt, inArray, lt, not, or, type SQL, sql } from 'drizzle-orm'
import type { freeagentBills, freeagentInvoices } from '../db/schema'
import { SETTLED_STATUSES } from './mapping'

type Doc = typeof freeagentBills | typeof freeagentInvoices

/** Owed, and not a draft or settled document. */
export function outstandingSql(table: Doc): SQL {
  const t = table as typeof freeagentInvoices
  return and(
    gt(t.dueValue, '0'),
    or(sql`${t.status} is null`, not(inArray(t.status, [...SETTLED_STATUSES])))
  ) as SQL
}

/** Outstanding and past its due date (today, in the database's clock), or marked Overdue. */
export function overdueSql(table: Doc): SQL {
  const t = table as typeof freeagentInvoices
  return or(
    eq(t.status, 'Overdue'),
    and(outstandingSql(table), lt(t.dueOn, sql`current_date`))
  ) as SQL
}
