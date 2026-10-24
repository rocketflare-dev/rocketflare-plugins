/**
 * Writing the mirror: one batched UPSERT per page, keyed on `(tenant_id, url)`.
 *
 * The sync and the writes both come through here, so a row a write touched and the row the next
 * sync brings back are the same row. A batch upsert sets each column from `excluded` — the incoming
 * value — and only the columns the mapper produced, which is what lets the PARTIAL explanation a
 * bank transaction embeds update its own fields without wiping the category the explanations
 * endpoint wrote.
 */
import { and, eq, getTableColumns, inArray, notInArray, type SQL, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { Database } from '@/plugins/api'
import {
  freeagentBankAccounts,
  freeagentBankTransactions,
  freeagentBills,
  freeagentCategories,
  freeagentContacts,
  freeagentExplanations,
  freeagentInvoices,
} from '../db/schema'

/** The mirror tables, all shaped `{ tenantId, url, … }` with a unique `(tenant_id, url)`. */
export const MIRROR_TABLES = {
  bankAccounts: freeagentBankAccounts,
  bankTransactions: freeagentBankTransactions,
  explanations: freeagentExplanations,
  categories: freeagentCategories,
  contacts: freeagentContacts,
  bills: freeagentBills,
  invoices: freeagentInvoices,
} as const
export type MirrorTable = (typeof MIRROR_TABLES)[keyof typeof MIRROR_TABLES]

/** Postgres caps a statement at 65 535 parameters; 200 rows × ~15 columns is far below it. */
const BATCH = 200

/**
 * Upsert `rows` (each already mapped, without `tenantId`) into one mirror table for one tenant.
 * Every row in a call must carry the same keys — true of every mapper's output.
 */
export async function upsertMirror(
  db: Database,
  table: MirrorTable,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<number> {
  if (rows.length === 0) return 0
  const columns = getTableColumns(table as PgTable) as Record<string, { name: string }>
  const keys = Object.keys(rows[0] ?? {}).filter(k => k !== 'url' && k in columns)
  const set: Record<string, SQL | Date> = { updatedAt: new Date() }
  for (const key of keys) {
    const column = columns[key]
    if (column) set[key] = sql.raw(`excluded."${column.name}"`)
  }
  const target = table as typeof freeagentBills
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows.slice(i, i + BATCH).map(r => ({ ...r, tenantId }))
    await db
      .insert(target)
      .values(values as (typeof freeagentBills.$inferInsert)[])
      .onConflictDoUpdate({ target: [target.tenantId, target.url], set })
  }
  return rows.length
}

/**
 * A transaction's embedded explanation list is the truth about which explanations it HAS: one
 * deleted in FreeAgent never comes back from `updated_since`, but its transaction does (its
 * unexplained amount moved). So remove this transaction's rows whose URL is no longer listed.
 */
export async function pruneExplanations(
  db: Database,
  tenantId: string,
  bankTransactionUrl: string,
  keepUrls: readonly string[]
): Promise<void> {
  await db
    .delete(freeagentExplanations)
    .where(
      and(
        eq(freeagentExplanations.tenantId, tenantId),
        eq(freeagentExplanations.bankTransactionUrl, bankTransactionUrl),
        ...(keepUrls.length > 0 ? [notInArray(freeagentExplanations.url, [...keepUrls])] : [])
      )
    )
}

/** Delete mirror rows by URL — categories and bank accounts are re-listed whole each sync. */
export async function deleteMissing(
  db: Database,
  table: typeof freeagentCategories | typeof freeagentBankAccounts,
  tenantId: string,
  seenUrls: readonly string[]
): Promise<void> {
  const target = table as typeof freeagentCategories
  await db
    .delete(target)
    .where(
      and(
        eq(target.tenantId, tenantId),
        ...(seenUrls.length > 0 ? [notInArray(target.url, [...seenUrls])] : [])
      )
    )
}

export async function deleteByUrl(
  db: Database,
  table: MirrorTable,
  tenantId: string,
  urls: readonly string[]
): Promise<void> {
  if (urls.length === 0) return
  const target = table as typeof freeagentBills
  await db.delete(target).where(and(eq(target.tenantId, tenantId), inArray(target.url, [...urls])))
}
