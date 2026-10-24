/**
 * `freeagent.sync`: one organisation's books → the mirror, incrementally.
 *
 * FreeAgent has no webhooks, so this polls. Order, and why:
 *
 * 1. **Claim** — one conditional UPDATE on the connection (`sync_claimed_until`). A second job for
 *    the same tenant (the cron overlapping "Sync now", a redelivery) sees the claim and acks
 *    without work. The claim expires on its own, so a job that died never wedges the tenant.
 * 2. **Company** — name and currency, so Settings stays right after a rename.
 * 3. **Bank accounts, categories** — small, and FreeAgent offers no `updated_since` for either,
 *    so both are listed whole and anything no longer listed is removed.
 * 4. **Contacts, then per bank account: transactions and explanations, then bills, invoices** —
 *    incremental by `updated_since`, paged, one cursor each in `freeagent_sync_state`.
 *    Transactions run across EVERY bank account. Each transaction carries its explanation list,
 *    which reconciles deletions (`pruneExplanations`); the explanations endpoint then fills in the
 *    category and tax the embedded copy lacks.
 * 5. **Listeners** — every `freeagent:sync-listeners` contribution, so a receipts matcher can
 *    rematch against what just changed. A listener's throw is logged; it fails nothing.
 *
 * **Cursors.** A cursor is the moment its pass STARTED, less a five-minute overlap for clock skew
 * between us and FreeAgent, written only when that resource's pass completed. Upserts are
 * idempotent, so the overlap costs a few re-read rows and never a missed one; a pass that failed
 * half-way leaves its cursor where it was and the next run repeats it.
 *
 * **First sync.** Transactions and explanations start `FIRST_SYNC_LOOKBACK_DAYS` back
 * (`from_date`) rather than at the company's beginning: a matcher wants this year's unexplained
 * lines, and a decade of history would cost the rate limit an afternoon.
 *
 * **Failure.** A `rate_limited` or `upstream` error is rethrown so the queue retries with backoff;
 * `needs_reconnect` (the token was refused) is recorded and NOT retried — no retry can fix it.
 */
import {
  FREEAGENT_BOOKS_ENTITY,
  FREEAGENT_CONNECTION_ENTITY,
  FREEAGENT_EXTENSION_KEYS,
} from '@rocketflare/shared/plugins/freeagent/index'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import type { JobCtx } from '@/plugins/api'
import { extensions } from '@/plugins/api/peers'
import {
  type FreeAgentConnectionRow,
  freeagentBankAccounts,
  freeagentCategories,
  freeagentConnections,
  freeagentSyncState,
} from '../db/schema'
import type { FreeAgentClient, Query } from './client'
import { clientForConnection } from './connection'
import { type FreeAgentDeps, freeagentHttp } from './env'
import { FreeAgentError, isFreeAgentError } from './errors'
import {
  mapBankAccount,
  mapBankTransaction,
  mapBill,
  mapCategories,
  mapCompany,
  mapContact,
  mapExplanation,
  mapInvoice,
} from './mapping'
import { deleteMissing, MIRROR_TABLES, pruneExplanations, upsertMirror } from './mirror'

/** How long one sync may hold the tenant before another may take over. */
export const SYNC_CLAIM_MS = 15 * 60_000
/** Overlap subtracted from a pass's start when it becomes the next `updated_since`. */
export const CURSOR_OVERLAP_MS = 5 * 60_000
export const FIRST_SYNC_LOOKBACK_DAYS = 400

/** What a listener is handed after a successful sync. */
export interface FreeAgentSyncSummary {
  tenantId: string
  startedAt: Date
  finishedAt: Date
  /** Rows upserted per resource family in this pass. */
  counts: Record<string, number>
}

/**
 * A plugin that wants to react to fresh books contributes one of these under
 * `freeagent:sync-listeners` (`extensions: freeagentExtensions({ syncListeners: [l] })`). Called
 * after every successful sync. Keep it quick — enqueue your own job — and idempotent: a sync with
 * nothing new still calls it. A throw is logged; it does not stop the other listeners.
 */
export interface FreeAgentSyncListener {
  id: string
  onSync(summary: FreeAgentSyncSummary, ctx: JobCtx): Promise<void>
}

const listenerSchema = z.object({
  id: z.string().min(1),
  onSync: z.custom<FreeAgentSyncListener['onSync']>(v => typeof v === 'function'),
})

/** Every installed listener, narrowed — a malformed contribution fails loudly, by plugin. */
export function freeagentSyncListeners(): FreeAgentSyncListener[] {
  return extensions(FREEAGENT_EXTENSION_KEYS.syncListeners).map(raw => {
    const parsed = listenerSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `freeagent: a contributed sync listener is malformed: ${parsed.error.message}`
      )
    }
    return parsed.data as FreeAgentSyncListener
  })
}

export type SyncOutcome =
  | { status: 'synced'; summary: FreeAgentSyncSummary }
  | { status: 'skipped'; reason: 'not_connected' | 'claimed' }
  | { status: 'needs_reconnect'; message: string }

interface SyncOptions {
  deps?: FreeAgentDeps
  listeners?: readonly FreeAgentSyncListener[]
  now?: () => Date
}

/** Take the tenant's sync claim, or answer why not. */
async function claim(
  ctx: JobCtx,
  tenantId: string,
  now: Date
): Promise<FreeAgentConnectionRow | 'not_connected' | 'claimed'> {
  const [row] = await ctx.db
    .update(freeagentConnections)
    .set({
      syncClaimedUntil: new Date(now.getTime() + SYNC_CLAIM_MS),
      lastSyncStartedAt: now,
    })
    .where(
      and(
        eq(freeagentConnections.tenantId, tenantId),
        eq(freeagentConnections.status, 'connected'),
        or(
          isNull(freeagentConnections.syncClaimedUntil),
          lt(freeagentConnections.syncClaimedUntil, now)
        )
      )
    )
    .returning()
  if (row) return row
  const [existing] = await ctx.db
    .select({ status: freeagentConnections.status })
    .from(freeagentConnections)
    .where(eq(freeagentConnections.tenantId, tenantId))
    .limit(1)
  return existing?.status === 'connected' ? 'claimed' : 'not_connected'
}

async function cursorFor(ctx: JobCtx, tenantId: string, resource: string): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ updatedSince: freeagentSyncState.updatedSince })
    .from(freeagentSyncState)
    .where(
      and(eq(freeagentSyncState.tenantId, tenantId), eq(freeagentSyncState.resource, resource))
    )
    .limit(1)
  return row?.updatedSince ?? null
}

async function saveCursor(
  ctx: JobCtx,
  tenantId: string,
  resource: string,
  updatedSince: Date,
  items: number,
  now: Date
): Promise<void> {
  const values = { updatedSince, lastSyncedAt: now, itemsSynced: items }
  await ctx.db
    .insert(freeagentSyncState)
    .values({ tenantId, resource, ...values })
    .onConflictDoUpdate({
      target: [freeagentSyncState.tenantId, freeagentSyncState.resource],
      set: { ...values, updatedAt: now },
    })
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * One incremental resource: page through `path` from its cursor, hand each page to `onPage`, and
 * move the cursor only once every page has landed.
 */
async function syncIncremental(
  ctx: JobCtx,
  client: FreeAgentClient,
  tenantId: string,
  spec: {
    resource: string
    path: string
    key: string
    query?: Query
    /** On the first pass only — bounds history (`from_date`). */
    firstPassQuery?: Query
    onPage: (items: unknown[]) => Promise<number>
  },
  passStartedAt: Date
): Promise<number> {
  const since = await cursorFor(ctx, tenantId, spec.resource)
  const query: Query = {
    ...spec.query,
    ...(since ? { updated_since: since.toISOString() } : spec.firstPassQuery),
  }
  let count = 0
  for await (const page of client.pages(spec.path, spec.key, query)) {
    count += await spec.onPage(page)
  }
  const next = new Date(passStartedAt.getTime() - CURSOR_OVERLAP_MS)
  await saveCursor(ctx, tenantId, spec.resource, next, count, new Date())
  return count
}

/** Every step after the claim. Throws; `syncTenant` records the outcome. */
async function runSync(
  ctx: JobCtx,
  client: FreeAgentClient,
  connection: FreeAgentConnectionRow,
  startedAt: Date
): Promise<Record<string, number>> {
  const { tenantId } = connection
  const counts: Record<string, number> = {}

  // Company: cheap, and keeps the name Settings shows current.
  const company = mapCompany(await client.get('/v2/company'))
  await ctx.db
    .update(freeagentConnections)
    .set({ companyName: company.companyName, companyCurrency: company.companyCurrency })
    .where(
      and(eq(freeagentConnections.tenantId, tenantId), eq(freeagentConnections.id, connection.id))
    )

  // Listed whole: no updated_since on either endpoint.
  const accounts = (await client.all('/v2/bank_accounts', 'bank_accounts')).map(mapBankAccount)
  counts.bankAccounts = await upsertMirror(ctx.db, MIRROR_TABLES.bankAccounts, tenantId, accounts)
  await deleteMissing(
    ctx.db,
    freeagentBankAccounts,
    tenantId,
    accounts.map(a => a.url)
  )

  const categories = mapCategories(await client.get('/v2/categories'))
  counts.categories = await upsertMirror(ctx.db, MIRROR_TABLES.categories, tenantId, categories)
  await deleteMissing(
    ctx.db,
    freeagentCategories,
    tenantId,
    categories.map(c => c.url)
  )

  counts.contacts = await syncIncremental(
    ctx,
    client,
    tenantId,
    {
      resource: 'contacts',
      path: '/v2/contacts',
      key: 'contacts',
      query: { view: 'all' },
      onPage: items =>
        upsertMirror(ctx.db, MIRROR_TABLES.contacts, tenantId, items.map(mapContact)),
    },
    startedAt
  )

  const firstPass: Query = {
    from_date: isoDate(new Date(startedAt.getTime() - FIRST_SYNC_LOOKBACK_DAYS * 86_400_000)),
  }
  counts.bankTransactions = 0
  counts.explanations = 0
  for (const account of accounts) {
    counts.bankTransactions += await syncIncremental(
      ctx,
      client,
      tenantId,
      {
        resource: `bank_transactions:${account.url}`,
        path: '/v2/bank_transactions',
        key: 'bank_transactions',
        query: { bank_account: account.url, view: 'all' },
        firstPassQuery: firstPass,
        onPage: async items => {
          const mapped = items.map(mapBankTransaction)
          await upsertMirror(
            ctx.db,
            MIRROR_TABLES.bankTransactions,
            tenantId,
            mapped.map(m => m.row)
          )
          for (const m of mapped) {
            if (m.explanations === null) continue
            await upsertMirror(ctx.db, MIRROR_TABLES.explanations, tenantId, m.explanations)
            await pruneExplanations(
              ctx.db,
              tenantId,
              m.row.url,
              m.explanations.map(e => e.url)
            )
          }
          return mapped.length
        },
      },
      startedAt
    )
    counts.explanations += await syncIncremental(
      ctx,
      client,
      tenantId,
      {
        resource: `bank_transaction_explanations:${account.url}`,
        path: '/v2/bank_transaction_explanations',
        key: 'bank_transaction_explanations',
        query: { bank_account: account.url },
        firstPassQuery: firstPass,
        onPage: items =>
          upsertMirror(ctx.db, MIRROR_TABLES.explanations, tenantId, items.map(mapExplanation)),
      },
      startedAt
    )
  }

  counts.bills = await syncIncremental(
    ctx,
    client,
    tenantId,
    {
      resource: 'bills',
      path: '/v2/bills',
      key: 'bills',
      query: { view: 'all' },
      onPage: items => upsertMirror(ctx.db, MIRROR_TABLES.bills, tenantId, items.map(mapBill)),
    },
    startedAt
  )
  counts.invoices = await syncIncremental(
    ctx,
    client,
    tenantId,
    {
      resource: 'invoices',
      path: '/v2/invoices',
      key: 'invoices',
      query: { view: 'all' },
      onPage: items =>
        upsertMirror(ctx.db, MIRROR_TABLES.invoices, tenantId, items.map(mapInvoice)),
    },
    startedAt
  )
  return counts
}

export async function syncTenant(
  ctx: JobCtx,
  tenantId: string,
  opts: SyncOptions = {}
): Promise<SyncOutcome> {
  const now = opts.now ?? (() => new Date())
  const startedAt = now()
  const claimed = await claim(ctx, tenantId, startedAt)
  if (claimed === 'not_connected' || claimed === 'claimed') {
    return { status: 'skipped', reason: claimed }
  }
  const release = (patch: Partial<typeof freeagentConnections.$inferInsert>) =>
    ctx.db
      .update(freeagentConnections)
      .set({ syncClaimedUntil: null, ...patch })
      .where(
        and(eq(freeagentConnections.tenantId, tenantId), eq(freeagentConnections.id, claimed.id))
      )

  let counts: Record<string, number>
  try {
    const client = clientForConnection(ctx, claimed, opts.deps ?? freeagentHttp)
    counts = await runSync(ctx, client, claimed, startedAt)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isFreeAgentError(err, 'needs_reconnect')) {
      // The token source already marked the row; just let go of the claim.
      await release({})
      await ctx.nudge(tenantId, FREEAGENT_CONNECTION_ENTITY)
      ctx.logger.warn({ tenantId }, 'freeagent.sync: the connection needs an admin to reconnect')
      return { status: 'needs_reconnect', message }
    }
    await release({ lastError: message.slice(0, 1000), lastErrorAt: now() })
    await ctx.nudge(tenantId, FREEAGENT_CONNECTION_ENTITY)
    ctx.logger.error(
      { tenantId, code: err instanceof FreeAgentError ? err.code : 'internal', err: message },
      'freeagent.sync failed'
    )
    throw err
  }

  const finishedAt = now()
  await release({ lastSyncAt: finishedAt, lastError: null, lastErrorAt: null })
  const summary: FreeAgentSyncSummary = { tenantId, startedAt, finishedAt, counts }
  for (const listener of opts.listeners ?? freeagentSyncListeners()) {
    try {
      await listener.onSync(summary, ctx)
    } catch (err) {
      ctx.logger.error(
        { tenantId, listener: listener.id, err: err instanceof Error ? err.message : String(err) },
        'freeagent: sync listener failed'
      )
    }
  }
  await ctx.nudge(tenantId, FREEAGENT_CONNECTION_ENTITY)
  await ctx.nudge(tenantId, FREEAGENT_BOOKS_ENTITY)
  return { status: 'synced', summary }
}
