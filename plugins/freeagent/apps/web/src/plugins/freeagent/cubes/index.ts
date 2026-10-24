/**
 * drizzle-cube cubes over the mirror, contributed to the `analytics` plugin through `extensions`.
 *
 * **Inert without analytics, and deliberately so.** The contribution goes under analytics' own
 * extension keys (`analytics:cubes`, `analytics:cubeIsolationCases`) as plain data: nothing here
 * imports the analytics plugin or `drizzle-cube`, so this plugin needs neither installed and
 * declares no `requires.plugins`. When analytics IS installed it reads these, narrows them, serves
 * them at `/cubejs-api`, and its mandatory cube-isolation test runs the cases below against them.
 * `defineCube(name, def)` in drizzle-cube is `{ name, ...def }`, which is the shape written here.
 *
 * Every cube's `sql()` scopes its base query by the security context's tenant (`tenantOf`), which
 * throws rather than compiling `tenant_id = NULL`. Joins match on the URL AND the tenant: FreeAgent
 * category URLs (`/v2/categories/285`) are the same in every company, so a URL-only join would
 * cross organisations. `tests/api/cubes.test.ts` proves the scoping without analytics installed.
 *
 * Member names are frozen once released: dashboards reference them.
 */
import { eq, gt, lt, type SQL, sql } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import {
  freeagentBankTransactions,
  freeagentBills,
  freeagentCategories,
  freeagentExplanations,
  freeagentInvoices,
} from '../db/schema'
import { outstandingSql, overdueSql } from '../services/overdue'

/** The slice of drizzle-cube's `QueryContext` a cube reads. */
export interface CubeQueryContext {
  securityContext: Record<string, unknown>
}

export function tenantOf(ctx: CubeQueryContext): string {
  const tenantId = ctx.securityContext.tenantId
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('freeagent cube queried without a tenant in the security context')
  }
  return tenantId
}

/** One cube, as drizzle-cube's `defineCube` would return it. */
export interface FreeAgentCube {
  name: string
  title: string
  description: string
  sql: (ctx: CubeQueryContext) => { from: unknown; where: SQL | undefined }
  joins?: Record<string, unknown>
  dimensions: Record<string, Record<string, unknown>>
  measures: Record<string, Record<string, unknown>>
}

const tx = freeagentBankTransactions
const ex = freeagentExplanations
const cat = freeagentCategories
const inv = freeagentInvoices
const bill = freeagentBills

export const freeagentCategoriesCube: FreeAgentCube = {
  name: 'FreeAgentCategories',
  title: 'FreeAgent Categories',
  description: 'Accounting categories (nominal codes) in FreeAgent',
  sql: ctx => ({ from: cat, where: eq(cat.tenantId, tenantOf(ctx)) }),
  dimensions: {
    id: { name: 'id', title: 'ID', type: 'string', sql: cat.id, primaryKey: true },
    url: { name: 'url', title: 'URL', type: 'string', sql: cat.url },
    description: { name: 'description', title: 'Category', type: 'string', sql: cat.description },
    nominalCode: {
      name: 'nominalCode',
      title: 'Nominal Code',
      type: 'string',
      sql: cat.nominalCode,
    },
    kind: { name: 'kind', title: 'Group', type: 'string', sql: cat.kind },
  },
  measures: {
    count: { name: 'count', title: 'Categories', type: 'count', sql: cat.id },
  },
}

export const freeagentTransactionsCube: FreeAgentCube = {
  name: 'FreeAgentTransactions',
  title: 'FreeAgent Bank Transactions',
  description:
    'Bank transactions mirrored from FreeAgent: money in and out, and what is unexplained',
  sql: ctx => ({ from: tx, where: eq(tx.tenantId, tenantOf(ctx)) }),
  dimensions: {
    id: { name: 'id', title: 'ID', type: 'string', sql: tx.id, primaryKey: true },
    url: { name: 'url', title: 'URL', type: 'string', sql: tx.url },
    datedOn: { name: 'datedOn', title: 'Date', type: 'time', sql: tx.datedOn },
    bankAccountUrl: {
      name: 'bankAccountUrl',
      title: 'Bank Account',
      type: 'string',
      sql: tx.bankAccountUrl,
    },
    description: { name: 'description', title: 'Description', type: 'string', sql: tx.description },
    isUnexplained: {
      name: 'isUnexplained',
      title: 'Unexplained',
      type: 'boolean',
      sql: tx.isUnexplained,
    },
    direction: {
      name: 'direction',
      title: 'Direction',
      type: 'string',
      sql: sql`case when ${tx.amount} < 0 then 'out' else 'in' end`,
    },
  },
  measures: {
    count: { name: 'count', title: 'Transactions', type: 'count', sql: tx.id },
    net: { name: 'net', title: 'Net Movement', type: 'sum', sql: tx.amount },
    moneyIn: {
      name: 'moneyIn',
      title: 'Money In',
      type: 'sum',
      sql: tx.amount,
      filters: [() => gt(tx.amount, '0')],
    },
    moneyOut: {
      name: 'moneyOut',
      title: 'Money Out',
      type: 'sum',
      sql: tx.amount,
      filters: [() => lt(tx.amount, '0')],
    },
    unexplainedCount: {
      name: 'unexplainedCount',
      title: 'Unexplained Transactions',
      type: 'count',
      sql: tx.id,
      filters: [() => eq(tx.isUnexplained, true)],
    },
    unexplainedAmount: {
      name: 'unexplainedAmount',
      title: 'Unexplained Amount',
      type: 'sum',
      sql: tx.unexplainedAmount,
    },
  },
}

export const freeagentExplanationsCube: FreeAgentCube = {
  name: 'FreeAgentExplanations',
  title: 'FreeAgent Explanations',
  description: 'How bank transactions were explained: spend and income by category',
  sql: ctx => ({ from: ex, where: eq(ex.tenantId, tenantOf(ctx)) }),
  joins: {
    FreeAgentCategories: {
      targetCube: () => freeagentCategoriesCube,
      relationship: 'belongsTo',
      on: [
        { source: ex.categoryUrl, target: cat.url },
        { source: ex.tenantId, target: cat.tenantId },
      ],
    },
  },
  dimensions: {
    id: { name: 'id', title: 'ID', type: 'string', sql: ex.id, primaryKey: true },
    datedOn: { name: 'datedOn', title: 'Date', type: 'time', sql: ex.datedOn },
    entryType: { name: 'entryType', title: 'Type', type: 'string', sql: ex.entryType },
    categoryUrl: {
      name: 'categoryUrl',
      title: 'Category URL',
      type: 'string',
      sql: ex.categoryUrl,
    },
  },
  measures: {
    count: { name: 'count', title: 'Explanations', type: 'count', sql: ex.id },
    gross: { name: 'gross', title: 'Gross Value', type: 'sum', sql: ex.grossValue },
    spend: {
      name: 'spend',
      title: 'Spend',
      type: 'sum',
      sql: sql`-${ex.grossValue}`,
      filters: [() => lt(ex.grossValue, '0')],
    },
    income: {
      name: 'income',
      title: 'Income',
      type: 'sum',
      sql: ex.grossValue,
      filters: [() => gt(ex.grossValue, '0')],
    },
    salesTax: { name: 'salesTax', title: 'Sales Tax', type: 'sum', sql: ex.salesTaxValue },
    withAttachments: {
      name: 'withAttachments',
      title: 'With Attachments',
      type: 'count',
      sql: ex.id,
      filters: [() => gt(ex.attachmentCount, 0)],
    },
  },
}

function documentCube(
  name: 'FreeAgentInvoices' | 'FreeAgentBills',
  table: typeof freeagentInvoices | typeof freeagentBills
): FreeAgentCube {
  const t = table as typeof freeagentInvoices
  const noun = name === 'FreeAgentInvoices' ? 'Invoices' : 'Bills'
  return {
    name,
    title: `FreeAgent ${noun}`,
    description:
      name === 'FreeAgentInvoices'
        ? 'Sales invoices: billed, outstanding and overdue'
        : 'Supplier bills: owed, outstanding and overdue',
    sql: ctx => ({ from: t, where: eq(t.tenantId, tenantOf(ctx)) }),
    dimensions: {
      id: { name: 'id', title: 'ID', type: 'string', sql: t.id, primaryKey: true },
      url: { name: 'url', title: 'URL', type: 'string', sql: t.url },
      reference: { name: 'reference', title: 'Reference', type: 'string', sql: t.reference },
      status: { name: 'status', title: 'Status', type: 'string', sql: t.status },
      currency: { name: 'currency', title: 'Currency', type: 'string', sql: t.currency },
      datedOn: { name: 'datedOn', title: 'Date', type: 'time', sql: t.datedOn },
      dueOn: { name: 'dueOn', title: 'Due', type: 'time', sql: t.dueOn },
    },
    measures: {
      count: { name: 'count', title: noun, type: 'count', sql: t.id },
      total: { name: 'total', title: 'Total', type: 'sum', sql: t.totalValue },
      paid: { name: 'paid', title: 'Paid', type: 'sum', sql: t.paidValue },
      outstanding: {
        name: 'outstanding',
        title: 'Outstanding',
        type: 'sum',
        sql: t.dueValue,
        filters: [() => outstandingSql(table)],
      },
      overdueCount: {
        name: 'overdueCount',
        title: `Overdue ${noun}`,
        type: 'count',
        sql: t.id,
        filters: [() => overdueSql(table)],
      },
      overdueAmount: {
        name: 'overdueAmount',
        title: 'Overdue Amount',
        type: 'sum',
        sql: t.dueValue,
        filters: [() => overdueSql(table)],
      },
    },
  }
}

export const freeagentInvoicesCube = documentCube('FreeAgentInvoices', freeagentInvoices)
export const freeagentBillsCube = documentCube('FreeAgentBills', freeagentBills)

export const FREEAGENT_CUBES: readonly FreeAgentCube[] = [
  freeagentBillsCube,
  freeagentCategoriesCube,
  freeagentExplanationsCube,
  freeagentInvoicesCube,
  freeagentTransactionsCube,
]

// ---- Isolation cases (the analytics plugin's `CubeIsolationCase` shape) -------------------------

type Rows = Array<Record<string, unknown>>

/**
 * One case per cube. Analytics seeds tenant A then tenant B, then queries as each; the seed puts
 * the tenant's id into every row's URL, and `expect` checks each side sees only its own — and that
 * it sees them at all. The seeded ids are remembered in call order, which is how `expect` (given
 * only `'a' | 'b'`) knows which tenant it is looking at.
 */
function isolationCase(
  cube: string,
  member: string,
  seed: (db: Database, tenantId: string) => Promise<void>
) {
  const seeded: string[] = []
  return {
    cube,
    seed: async (db: Database, ctx: { tenantId: string; userId: string }) => {
      seeded.push(ctx.tenantId)
      await seed(db, ctx.tenantId)
    },
    query: { measures: [`${cube}.count`], dimensions: [`${cube}.${member}`] },
    expect: (rows: Rows, side: 'a' | 'b') => {
      const mine = seeded[seeded.length - (side === 'a' ? 2 : 1)] ?? ''
      const other = seeded[seeded.length - (side === 'a' ? 1 : 2)] ?? ''
      // Plain throws, not vitest's `expect`: this file ships in the Worker bundle.
      const values = rows.map(r => String(r[`${cube}.${member}`]))
      if (values.length === 0) throw new Error(`${cube}: no rows for side ${side}`)
      for (const v of values) {
        if (!mine || !v.includes(mine) || (other && v.includes(other))) {
          throw new Error(`${cube}: side ${side} saw a row that is not its own (${v})`)
        }
      }
    },
  }
}

const fa = (tenantId: string, path: string) =>
  `https://api.sandbox.freeagent.com/v2/${path}/${tenantId}`

export const FREEAGENT_CUBE_ISOLATION_CASES = [
  isolationCase('FreeAgentTransactions', 'url', async (db, tenantId) => {
    await db.insert(tx).values({
      tenantId,
      url: fa(tenantId, 'bank_transactions'),
      bankAccountUrl: fa(tenantId, 'bank_accounts'),
      datedOn: '2026-10-01',
      amount: '-12.00',
      unexplainedAmount: '-12.00',
      isUnexplained: true,
    })
  }),
  isolationCase('FreeAgentCategories', 'url', async (db, tenantId) => {
    await db.insert(cat).values({
      tenantId,
      url: fa(tenantId, 'categories'),
      description: 'Travel',
      kind: 'admin_expenses',
    })
  }),
  isolationCase('FreeAgentExplanations', 'categoryUrl', async (db, tenantId) => {
    await db.insert(ex).values({
      tenantId,
      url: fa(tenantId, 'bank_transaction_explanations'),
      categoryUrl: fa(tenantId, 'categories'),
      grossValue: '-12.00',
      datedOn: '2026-10-01',
    })
  }),
  isolationCase('FreeAgentInvoices', 'url', async (db, tenantId) => {
    await db.insert(inv).values({
      tenantId,
      url: fa(tenantId, 'invoices'),
      status: 'Open',
      totalValue: '100.00',
      dueValue: '100.00',
      dueOn: '2026-01-01',
    })
  }),
  isolationCase('FreeAgentBills', 'url', async (db, tenantId) => {
    await db.insert(bill).values({
      tenantId,
      url: fa(tenantId, 'bills'),
      status: 'Open',
      totalValue: '50.00',
      dueValue: '50.00',
      dueOn: '2026-01-01',
    })
  }),
]

/** `analyticsExtensions({ cubes, cubeIsolationCases })`, spelled without importing analytics. */
export const FREEAGENT_ANALYTICS_EXTENSIONS: Record<string, readonly unknown[]> = {
  'analytics:cubes': FREEAGENT_CUBES,
  'analytics:cubeIsolationCases': FREEAGENT_CUBE_ISOLATION_CASES,
}
