/**
 * Agent tools over the organisation's FreeAgent books.
 *
 * Five read tools answer from the MIRROR (no FreeAgent call, no rate limit spent): company and
 * sync status, transaction search, categories, invoices and bills. Two write tools call FreeAgent
 * and are `requiresApproval: true` — the loop stops and a person approves the exact arguments
 * before the handler runs (`Tool.requiresApproval`, enforced by the kit's tool loop, never here).
 *
 * The builder offers nothing to a tenant that is not connected (`[]`), so a model is never shown a
 * tool that could only answer "not connected". The write tools are offered only to an admin-level
 * requester (`scope.bypass`): a member's run may read the books but not propose changes to them.
 *
 * Tools are bound to the RUN's tenant (`ctx.tenantId`); no input names a tenant.
 */
import {
  freeagentCreateBillInputSchema,
  freeagentExplainInputSchema,
} from '@rocketflare/shared/plugins/freeagent/index'
import { and, asc, desc, eq, gte, ilike, lte, or, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Tool, ToolCtx } from '@/plugins/api'
import { defineTool } from '@/plugins/api'
import { loadStatus } from '../api/status'
import {
  freeagentBankAccounts,
  freeagentBankTransactions,
  freeagentBills,
  freeagentCategories,
  freeagentContacts,
  freeagentInvoices,
} from '../db/schema'
import { isUsable } from '../services/connection'
import type { FreeAgentDeps } from '../services/env'
import { freeagentHttp } from '../services/env'
import { isFreeAgentError } from '../services/errors'
import { isOverdue } from '../services/mapping'
import { overdueSql } from '../services/overdue'
import { createBill, explainTransaction } from '../services/writes'

export const FREEAGENT_TOOL_NAMES = {
  company: 'freeagent_company',
  searchTransactions: 'freeagent_search_transactions',
  listCategories: 'freeagent_list_categories',
  listInvoices: 'freeagent_list_invoices',
  listBills: 'freeagent_list_bills',
  explainTransaction: 'freeagent_explain_transaction',
  createBill: 'freeagent_create_bill',
} as const

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(`How many to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`)
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const amountSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'A decimal such as 12.50')

function escapeLike(text: string): string {
  return `%${text.replace(/[%_\\]/g, m => `\\${m}`)}%`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** A FreeAgent failure as something the model can act on, never a stack. */
function toolError(err: unknown): string {
  if (isFreeAgentError(err)) {
    return JSON.stringify({
      error: err.code,
      message: err.message,
      ...(err.code === 'needs_reconnect' && {
        hint: 'Tell the user an admin must reconnect FreeAgent in Settings → FreeAgent.',
      }),
      ...(err.code === 'rate_limited' && {
        hint: `FreeAgent is rate limiting; retry in about ${err.retryAfterSeconds ?? 60} seconds.`,
      }),
      ...(err.code === 'validation' && {
        hint: 'FreeAgent rejected the input. Check the URLs come from the freeagent_* tools and the amount is signed like the transaction.',
      }),
    })
  }
  throw err
}

export function companyTool(ctx: ToolCtx): Tool<Record<string, never>> {
  return defineTool({
    name: FREEAGENT_TOOL_NAMES.company,
    description:
      "The organisation's FreeAgent connection: company name, currency, environment, when the books " +
      'were last synced, and how many accounts, transactions (and unexplained ones), invoices and bills are mirrored.',
    schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    async handler() {
      const s = await loadStatus(ctx.db, ctx.config, ctx.tenantId)
      return JSON.stringify({
        company: s.companyName,
        currency: s.companyCurrency,
        environment: s.connectionEnvironment,
        status: s.status,
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
        lastError: s.lastError,
        counts: s.counts,
        note: 'Figures come from a mirror synced every 30 minutes; recent changes in FreeAgent may not show yet.',
      })
    },
  })
}

export const searchTransactionsInputSchema = z.object({
  from: dateSchema.optional().describe('Earliest date, inclusive'),
  to: dateSchema.optional().describe('Latest date, inclusive'),
  amount: amountSchema
    .optional()
    .describe('Exact amount, signed (money out is negative, e.g. -12.50)'),
  minAmount: amountSchema.optional().describe('Smallest signed amount, inclusive'),
  maxAmount: amountSchema.optional().describe('Largest signed amount, inclusive'),
  text: z.string().trim().max(200).optional().describe('Match against the bank description'),
  unexplainedOnly: z.boolean().optional().describe('Only transactions not yet fully explained'),
  limit: limitSchema,
})
export type SearchTransactionsInput = z.infer<typeof searchTransactionsInputSchema>

export function searchTransactionsTool(ctx: ToolCtx): Tool<SearchTransactionsInput> {
  return defineTool({
    name: FREEAGENT_TOOL_NAMES.searchTransactions,
    description:
      'Search bank transactions in FreeAgent by date range, signed amount (money out is negative), ' +
      'description text, or unexplained only. Answers each transaction URL (use it with ' +
      'freeagent_explain_transaction), date, amount, unexplained amount and bank account.',
    schema: searchTransactionsInputSchema,
    async handler(input) {
      const t = freeagentBankTransactions
      const filters: SQL[] = [eq(t.tenantId, ctx.tenantId)]
      if (input.from) filters.push(gte(t.datedOn, input.from))
      if (input.to) filters.push(lte(t.datedOn, input.to))
      if (input.amount) filters.push(eq(t.amount, input.amount))
      if (input.minAmount) filters.push(gte(t.amount, input.minAmount))
      if (input.maxAmount) filters.push(lte(t.amount, input.maxAmount))
      if (input.unexplainedOnly) filters.push(eq(t.isUnexplained, true))
      if (input.text) {
        const match = or(
          ilike(t.description, escapeLike(input.text)),
          ilike(t.fullDescription, escapeLike(input.text))
        )
        if (match) filters.push(match)
      }
      const rows = await ctx.db
        .select({ tx: t, account: freeagentBankAccounts.name })
        .from(t)
        .leftJoin(
          freeagentBankAccounts,
          and(
            eq(freeagentBankAccounts.tenantId, t.tenantId),
            eq(freeagentBankAccounts.url, t.bankAccountUrl)
          )
        )
        .where(and(...filters))
        .orderBy(desc(t.datedOn), asc(t.url))
        .limit(input.limit ?? DEFAULT_LIMIT)
      if (rows.length === 0) {
        return JSON.stringify({
          transactions: [],
          hint: 'No mirrored transaction matches. Widen the date range or drop a filter; the mirror holds about the last 400 days.',
        })
      }
      return JSON.stringify({
        transactions: rows.map(({ tx, account }) => ({
          url: tx.url,
          datedOn: tx.datedOn,
          amount: tx.amount,
          unexplainedAmount: tx.unexplainedAmount,
          unexplained: tx.isUnexplained,
          description: tx.description,
          bankAccount: account,
          bankAccountUrl: tx.bankAccountUrl,
        })),
      })
    },
  })
}

export const listCategoriesInputSchema = z.object({
  search: z.string().trim().max(100).optional().describe('Match description or nominal code'),
  kind: z
    .enum(['admin_expenses', 'cost_of_sales', 'income', 'general'])
    .optional()
    .describe('Which group of categories'),
})
export type ListCategoriesInput = z.infer<typeof listCategoriesInputSchema>

export function listCategoriesTool(ctx: ToolCtx): Tool<ListCategoriesInput> {
  return defineTool({
    name: FREEAGENT_TOOL_NAMES.listCategories,
    description:
      'List FreeAgent accounting categories (nominal codes): URL, description, code, group and ' +
      'automatic VAT rate. Use a category URL with freeagent_explain_transaction or freeagent_create_bill.',
    schema: listCategoriesInputSchema,
    async handler(input) {
      const c = freeagentCategories
      const filters: SQL[] = [eq(c.tenantId, ctx.tenantId)]
      if (input.kind) filters.push(eq(c.kind, input.kind))
      if (input.search) {
        const match = or(
          ilike(c.description, escapeLike(input.search)),
          ilike(c.nominalCode, escapeLike(input.search))
        )
        if (match) filters.push(match)
      }
      const rows = await ctx.db
        .select()
        .from(c)
        .where(and(...filters))
        .orderBy(asc(c.nominalCode))
        .limit(300)
      return JSON.stringify({
        categories: rows.map(r => ({
          url: r.url,
          description: r.description,
          nominalCode: r.nominalCode,
          kind: r.kind,
          group: r.groupDescription,
          autoSalesTaxRate: r.autoSalesTaxRate,
        })),
        ...(rows.length === 0 && { hint: 'No category matches; try a shorter search or none.' }),
      })
    },
  })
}

export const listDocumentsInputSchema = z.object({
  overdueOnly: z.boolean().optional().describe('Only those still owed and past their due date'),
  status: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe('FreeAgent status, e.g. Open, Overdue, Paid, Draft'),
  limit: limitSchema,
})
export type ListDocumentsInput = z.infer<typeof listDocumentsInputSchema>

function documentsTool(ctx: ToolCtx, kind: 'invoices' | 'bills'): Tool<ListDocumentsInput> {
  const table = kind === 'invoices' ? freeagentInvoices : freeagentBills
  const t = table as typeof freeagentInvoices
  return defineTool({
    name: kind === 'invoices' ? FREEAGENT_TOOL_NAMES.listInvoices : FREEAGENT_TOOL_NAMES.listBills,
    description:
      kind === 'invoices'
        ? 'List sales invoices from FreeAgent, newest first: reference, client, dates, total, paid, still due, and whether overdue.'
        : 'List supplier bills from FreeAgent, newest first: reference, supplier, dates, total, paid, still due, and whether overdue.',
    schema: listDocumentsInputSchema,
    async handler(input) {
      const filters: SQL[] = [eq(t.tenantId, ctx.tenantId)]
      if (input.overdueOnly) filters.push(overdueSql(table))
      if (input.status) filters.push(sql`lower(${t.status}) = lower(${input.status})`)
      const rows = await ctx.db
        .select({ doc: t, contact: freeagentContacts.displayName })
        .from(t)
        .leftJoin(
          freeagentContacts,
          and(eq(freeagentContacts.tenantId, t.tenantId), eq(freeagentContacts.url, t.contactUrl))
        )
        .where(and(...filters))
        .orderBy(desc(t.datedOn), asc(t.url))
        .limit(input.limit ?? DEFAULT_LIMIT)
      const day = today()
      return JSON.stringify({
        [kind]: rows.map(({ doc, contact }) => ({
          url: doc.url,
          reference: doc.reference,
          contact,
          status: doc.status,
          datedOn: doc.datedOn,
          dueOn: doc.dueOn,
          currency: doc.currency,
          total: doc.totalValue,
          paid: doc.paidValue,
          due: doc.dueValue,
          overdue: isOverdue(doc, day),
        })),
        ...(rows.length === 0 && { hint: `No ${kind} match. Say so rather than inventing any.` }),
      })
    },
  })
}

export const listInvoicesTool = (ctx: ToolCtx) => documentsTool(ctx, 'invoices')
export const listBillsTool = (ctx: ToolCtx) => documentsTool(ctx, 'bills')

export type ExplainTransactionToolInput = z.infer<typeof freeagentExplainInputSchema>

export function explainTransactionTool(
  ctx: ToolCtx,
  deps: FreeAgentDeps = freeagentHttp
): Tool<ExplainTransactionToolInput> {
  return defineTool({
    name: FREEAGENT_TOOL_NAMES.explainTransaction,
    description:
      'Explain a bank transaction in FreeAgent (WRITES to the books; a person approves first): the ' +
      'transaction URL from freeagent_search_transactions, a category URL from freeagent_list_categories, ' +
      'the gross value signed like the transaction (money out negative), the date, a description, and optionally the VAT rate.',
    schema: freeagentExplainInputSchema,
    requiresApproval: true,
    approvalMessage: 'Explain this bank transaction in FreeAgent?',
    allowEdits: true,
    async handler(input) {
      try {
        const explanation = await explainTransaction(ctx, ctx.tenantId, input, deps)
        return JSON.stringify({ explained: true, explanation })
      } catch (err) {
        return toolError(err)
      }
    },
  })
}

export type CreateBillToolInput = z.infer<typeof freeagentCreateBillInputSchema>

export function createBillTool(
  ctx: ToolCtx,
  deps: FreeAgentDeps = freeagentHttp
): Tool<CreateBillToolInput> {
  return defineTool({
    name: FREEAGENT_TOOL_NAMES.createBill,
    description:
      'Create a supplier bill in FreeAgent (WRITES to the books; a person approves first): the ' +
      'supplier contact URL, a reference, dated and due dates, and one or more items each with a ' +
      'category URL, description and total including VAT.',
    schema: freeagentCreateBillInputSchema,
    requiresApproval: true,
    approvalMessage: 'Create this bill in FreeAgent?',
    allowEdits: true,
    async handler(input) {
      try {
        const bill = await createBill(ctx, ctx.tenantId, input, deps)
        return JSON.stringify({ created: true, bill })
      } catch (err) {
        return toolError(err)
      }
    },
  })
}

/**
 * What `agentTools` offers this run: nothing unless the organisation is connected (and the
 * deployment configured); the two write tools only for an admin-level requester.
 */
export async function freeagentAgentTools(
  ctx: ToolCtx,
  deps: FreeAgentDeps = freeagentHttp
): Promise<Tool[]> {
  if (!(await isUsable(ctx, ctx.tenantId))) return []
  const tools: Tool[] = [
    companyTool(ctx) as Tool,
    searchTransactionsTool(ctx) as Tool,
    listCategoriesTool(ctx) as Tool,
    listInvoicesTool(ctx) as Tool,
    listBillsTool(ctx) as Tool,
  ]
  if (ctx.scope.bypass) {
    tools.push(explainTransactionTool(ctx, deps) as Tool, createBillTool(ctx, deps) as Tool)
  }
  return tools
}
