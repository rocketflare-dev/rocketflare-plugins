/**
 * `/api/freeagent` — the authenticated mount: status, connect, disconnect, sync now, and the two
 * mirror lists the FreeAgent page shows (unexplained transactions, recent invoices).
 *
 * Connecting is a browser round trip through FreeAgent: `POST /connect` answers the approve URL
 * with a SIGNED state naming this tenant and this admin, and the public callback
 * (`api/hooks.ts`) trusts nothing but that state. Every read here filters by the session's tenant;
 * nothing reaches FreeAgent itself except through the queued sync.
 */
import {
  FREEAGENT_BOOKS_ENTITY,
  FREEAGENT_CONNECTION_ENTITY,
  FREEAGENT_SUBJECT,
  FREEAGENT_SYNC_JOB,
  type FreeAgentInvoice,
  type FreeAgentInvoiceListQuery,
  type FreeAgentTransaction,
  type FreeAgentTransactionListQuery,
  freeagentInvoiceListQuerySchema,
  freeagentTransactionListQuerySchema,
} from '@rocketflare/shared/plugins/freeagent/index'
import { and, count, desc, eq, type SQL } from 'drizzle-orm'
import type { RequestCtx } from '@/plugins/api'
import { createRouter, recordActivity, requestCtx, signState, validate } from '@/plugins/api'
import {
  freeagentBankAccounts,
  freeagentBankTransactions,
  freeagentContacts,
  freeagentInvoices,
} from '../db/schema'
import { deleteConnection, loadConnection } from '../services/connection'
import { appCredentials, approveUrl, freeagentConfig, redirectUri } from '../services/env'
import { isOverdue } from '../services/mapping'
import { overdueSql } from '../services/overdue'
import { CONNECT_STATE_PURPOSE, CONNECT_STATE_TTL_SECONDS } from './hooks'
import { loadStatus } from './status'

export const freeagentRouter = createRouter()

freeagentRouter.get('/status', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', FREEAGENT_SUBJECT)
  return c.json(await loadStatus(ctx.db, ctx.config, ctx.tenantId))
})

freeagentRouter.post('/connect', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', FREEAGENT_SUBJECT)
  const credentials = appCredentials(ctx.config)
  if (!credentials) {
    ctx.unavailable(
      'FreeAgent is not set up on this deployment (FREEAGENT_CLIENT_ID / FREEAGENT_CLIENT_SECRET)',
      'freeagent_not_configured'
    )
  }
  const state = await signState(
    ctx.config,
    CONNECT_STATE_PURPOSE,
    { tenantId: ctx.tenantId, userId: ctx.userId },
    { ttlSeconds: CONNECT_STATE_TTL_SECONDS }
  )
  return c.json({
    approveUrl: approveUrl(freeagentConfig(ctx.config).FREEAGENT_ENVIRONMENT, {
      clientId: credentials.clientId,
      redirectUri: redirectUri(ctx.config.APP_URL),
      state,
    }),
  })
})

freeagentRouter.delete('/connection', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', FREEAGENT_SUBJECT)
  const existing = await loadConnection(ctx.db, ctx.tenantId)
  if (!existing) ctx.notFound('FreeAgent is not connected', 'freeagent_not_connected')
  await deleteConnection(ctx.db, ctx.tenantId)
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'freeagent.disconnected',
      subjectType: FREEAGENT_SUBJECT,
      subjectId: existing.id,
      metadata: { companyName: existing.companyName, environment: existing.environment },
    })
  )
  ctx.nudge(FREEAGENT_CONNECTION_ENTITY)
  ctx.nudge(FREEAGENT_BOOKS_ENTITY)
  return c.body(null, 204)
})

freeagentRouter.post('/sync', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', FREEAGENT_SUBJECT)
  const connection = await loadConnection(ctx.db, ctx.tenantId)
  if (!connection) ctx.notFound('FreeAgent is not connected', 'freeagent_not_connected')
  if (connection.status !== 'connected') {
    ctx.conflict('Reconnect to FreeAgent before syncing', 'freeagent_needs_reconnect')
  }
  const job = await ctx.enqueue({
    type: FREEAGENT_SYNC_JOB,
    payload: { tenantId: ctx.tenantId, requestedBy: ctx.userId },
  })
  return c.json({ jobId: job.id, type: FREEAGENT_SYNC_JOB }, 202)
})

freeagentRouter.get(
  '/transactions',
  validate('query', freeagentTransactionListQuerySchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('read', FREEAGENT_SUBJECT)
    const query = ctx.valid<FreeAgentTransactionListQuery>('query')
    const filters: SQL[] = [eq(freeagentBankTransactions.tenantId, ctx.tenantId)]
    if (query.unexplained !== undefined) {
      filters.push(eq(freeagentBankTransactions.isUnexplained, query.unexplained))
    }
    if (query.bankAccountUrl) {
      filters.push(eq(freeagentBankTransactions.bankAccountUrl, query.bankAccountUrl))
    }
    const where = and(...filters)
    const [rows, totals] = await Promise.all([
      ctx.db
        .select({ tx: freeagentBankTransactions, accountName: freeagentBankAccounts.name })
        .from(freeagentBankTransactions)
        .leftJoin(
          freeagentBankAccounts,
          and(
            eq(freeagentBankAccounts.tenantId, freeagentBankTransactions.tenantId),
            eq(freeagentBankAccounts.url, freeagentBankTransactions.bankAccountUrl)
          )
        )
        .where(where)
        .orderBy(desc(freeagentBankTransactions.datedOn), desc(freeagentBankTransactions.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      ctx.db.select({ total: count() }).from(freeagentBankTransactions).where(where),
    ])
    const items = rows.map(
      ({ tx, accountName }): FreeAgentTransaction => ({
        id: tx.id,
        url: tx.url,
        bankAccountUrl: tx.bankAccountUrl,
        bankAccountName: accountName,
        datedOn: tx.datedOn,
        amount: tx.amount,
        unexplainedAmount: tx.unexplainedAmount,
        isUnexplained: tx.isUnexplained,
        description: tx.description,
      })
    )
    return c.json(ctx.page(items, totals[0]?.total ?? 0, query))
  }
)

freeagentRouter.get('/invoices', validate('query', freeagentInvoiceListQuerySchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', FREEAGENT_SUBJECT)
  const query = ctx.valid<FreeAgentInvoiceListQuery>('query')
  const filters: SQL[] = [eq(freeagentInvoices.tenantId, ctx.tenantId)]
  if (query.overdue) filters.push(overdueSql(freeagentInvoices))
  const where = and(...filters)
  const [rows, totals] = await Promise.all([
    ctx.db
      .select({ inv: freeagentInvoices, contactName: freeagentContacts.displayName })
      .from(freeagentInvoices)
      .leftJoin(
        freeagentContacts,
        and(
          eq(freeagentContacts.tenantId, freeagentInvoices.tenantId),
          eq(freeagentContacts.url, freeagentInvoices.contactUrl)
        )
      )
      .where(where)
      .orderBy(desc(freeagentInvoices.datedOn), desc(freeagentInvoices.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    ctx.db.select({ total: count() }).from(freeagentInvoices).where(where),
  ])
  const today = new Date().toISOString().slice(0, 10)
  const items = rows.map(
    ({ inv, contactName }): FreeAgentInvoice => ({
      id: inv.id,
      url: inv.url,
      reference: inv.reference,
      contactName,
      status: inv.status,
      datedOn: inv.datedOn,
      dueOn: inv.dueOn,
      currency: inv.currency,
      totalValue: inv.totalValue,
      paidValue: inv.paidValue,
      dueValue: inv.dueValue,
      overdue: isOverdue(inv, today),
    })
  )
  return c.json(ctx.page(items, totals[0]?.total ?? 0, query))
})
