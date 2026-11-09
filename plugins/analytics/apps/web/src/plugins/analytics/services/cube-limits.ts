/**
 * How much database work one cube request may ask for.
 *
 * The library runs every query in a batch, for as long as each takes, and offers no limit of its
 * own, so both limits are here. The timeout is set with the transaction-scoped form, the one that
 * means the same thing under either driver.
 */
import { sql } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import { transaction } from '@/plugins/api'

/** Enough for the largest dashboard's portlets in one round trip. */
export const CUBE_BATCH_MAX = 50
export const CUBE_STATEMENT_TIMEOUT_MS = 20_000

/** Run `fn` in a transaction in which no single statement may run longer than `ms`. */
export function withStatementTimeout<T>(
  db: Database,
  ms: number,
  fn: (tx: Database) => Promise<T>
): Promise<T> {
  return transaction(db, async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${`${ms}ms`}, true)`)
    return fn(tx)
  })
}
