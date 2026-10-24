/**
 * The plugin end to end on real Postgres, with a FAKE FreeAgent behind an injected fetch: the
 * OAuth callback (bad state → 401; success stores sealed tokens), token refresh and `invalid_grant`
 * → needs reconnect, an incremental sync (upserts, cursors, pagination, deletions reconciled),
 * explain + attach updating the mirror, tools hidden until connected, the cron fan-out, and tenant
 * isolation — another organisation can neither read nor change anything through the mounts.
 *
 * Nothing here reaches FreeAgent: services take `deps`, and the one test that drives the real
 * callback route swaps `freeagentHttp.fetch` for its duration.
 */
import { readFileSync } from 'node:fs'
import {
  createExecutionContext,
  createTestEnv,
  createTestSession,
  createTestTenant,
  createTestUser,
  dispatchScheduled,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
  stubs,
  type TestEnv,
  waitOnExecutionContext,
} from '@testkit/integration'
import { makeCronCtx, makeJobCtx, makeToolCtx } from '@testkit/unit'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openSecret, signState } from '@/plugins/api'
import { CONNECT_STATE_PURPOSE } from '../../api/hooks'
import { enqueueSyncs, FREEAGENT_CRON } from '../../api/scheduled'
import {
  freeagentBankTransactions,
  freeagentBills,
  freeagentCategories,
  freeagentConnections,
  freeagentContacts,
  freeagentExplanations,
  freeagentInvoices,
  freeagentSyncState,
} from '../../db/schema'
import { freeagentClientFor, saveConnection } from '../../services/connection'
import { type FetchLike, type FreeAgentDeps, freeagentHttp } from '../../services/env'
import { syncTenant } from '../../services/sync'
import {
  attachToExplanation,
  explainTransaction,
  listUnexplainedTransactions,
} from '../../services/writes'
import { FREEAGENT_TOOL_NAMES, freeagentAgentTools } from '../../tools/freeagent-tools'

const db = setupTestDatabase()
const API = 'https://api.sandbox.freeagent.com'
const ORIGIN = { Origin: 'http://localhost:3000' }

function freeagentEnv(): TestEnv {
  return createTestEnv({
    FREEAGENT_CLIENT_ID: 'test-client',
    FREEAGENT_CLIENT_SECRET: 'test-secret',
    FREEAGENT_ENVIRONMENT: 'sandbox',
  } as Partial<TestEnv>)
}

// ---- A fake FreeAgent -----------------------------------------------------------------------------

interface Call {
  method: string
  url: URL
  headers: Headers
  body: string | null
}
type Handler = (call: Call) => Response | Promise<Response>

function reply(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  })
}

/** Routes keyed `METHOD /path`; records every call. An unknown route is a 404 the test will see. */
function fakeFreeAgent(routes: Record<string, Handler>) {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(call)
    const handler = routes[`${call.method} ${url.pathname}`]
    return handler
      ? handler(call)
      : reply({ errors: { error: { message: 'no route' } } }, { status: 404 })
  }
  const deps: FreeAgentDeps = { fetch, sleep: async () => {} }
  return { deps, calls, routes }
}

function tokenReply(n: number) {
  return reply({
    access_token: `access-${n}`,
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: `refresh-${n}`,
    refresh_token_expires_in: 631151957,
  })
}

const company = { company: { url: `${API}/v2/company`, name: 'GuideMode Ltd', currency: 'GBP' } }

/** Connect a tenant directly (no browser): a fresh access token, so no refresh on first use. */
async function connect(tenantId: string, userId: string, env: TestEnv, expiresInMs = 3_600_000) {
  const ctx = makeJobCtx({ db, env })
  await saveConnection(ctx, {
    tenantId,
    userId,
    environment: 'sandbox',
    tokens: {
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() + expiresInMs),
    },
    company: {
      companyUrl: `${API}/v2/company`,
      companyName: 'GuideMode Ltd',
      companyCurrency: 'GBP',
    },
  })
}

async function tenantWithOwner() {
  const tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  const cookie = {
    ...sessionCookieHeader(await createTestSession(db, owner.id, tenantId)),
    ...ORIGIN,
  }
  return { tenantId, userId: owner.id, cookie }
}

// ---- The books the fake serves --------------------------------------------------------------------

const ACCOUNT = `${API}/v2/bank_accounts/1`
const TX1 = `${API}/v2/bank_transactions/101`
const TX2 = `${API}/v2/bank_transactions/102`
const EXP1 = `${API}/v2/bank_transaction_explanations/501`
const CATEGORY = `${API}/v2/categories/285`

function booksRoutes(state: { pass: number }): Record<string, Handler> {
  return {
    'GET /v2/company': () => reply(company),
    'GET /v2/bank_accounts': () =>
      reply({
        bank_accounts: [
          {
            url: ACCOUNT,
            name: 'Business Current',
            type: 'StandardBankAccount',
            currency: 'GBP',
            current_balance: '1500.25',
            is_primary: true,
          },
        ],
      }),
    'GET /v2/categories': () =>
      reply({
        admin_expenses_categories: [{ url: CATEGORY, description: 'Travel', nominal_code: '285' }],
        income_categories: [
          { url: `${API}/v2/categories/001`, description: 'Sales', nominal_code: '001' },
        ],
      }),
    // Two pages, to prove the sync follows Link.
    'GET /v2/contacts': ({ url }) =>
      url.searchParams.get('page') === '2'
        ? reply({ contacts: [{ url: `${API}/v2/contacts/2`, organisation_name: 'Rail Co' }] })
        : reply(
            { contacts: [{ url: `${API}/v2/contacts/1`, organisation_name: 'Acme Ltd' }] },
            { headers: { Link: `<${API}/v2/contacts?page=2&per_page=100>; rel="next"` } }
          ),
    'GET /v2/bank_transactions': () =>
      state.pass === 1
        ? reply({
            bank_transactions: [
              {
                url: TX1,
                bank_account: ACCOUNT,
                dated_on: '2026-10-01',
                amount: '-42.50',
                description: 'TRAINLINE',
                unexplained_amount: '-42.50',
                bank_transaction_explanations: [],
              },
              {
                url: TX2,
                bank_account: ACCOUNT,
                dated_on: '2026-10-02',
                amount: '1200.00',
                description: 'ACME PAYMENT',
                unexplained_amount: '0.0',
                bank_transaction_explanations: [
                  {
                    url: EXP1,
                    bank_account: ACCOUNT,
                    dated_on: '2026-10-02',
                    entry_type: 'Invoice Receipt',
                    gross_value: '1200.0',
                  },
                ],
              },
            ],
          })
        : // Second pass: the explanation on TX2 was deleted in FreeAgent.
          reply({
            bank_transactions: [
              {
                url: TX2,
                bank_account: ACCOUNT,
                dated_on: '2026-10-02',
                amount: '1200.00',
                description: 'ACME PAYMENT',
                unexplained_amount: '1200.00',
                bank_transaction_explanations: [],
              },
            ],
          }),
    'GET /v2/bank_transaction_explanations': () =>
      reply({
        bank_transaction_explanations:
          state.pass === 1
            ? [
                {
                  url: EXP1,
                  bank_transaction: TX2,
                  bank_account: ACCOUNT,
                  category: `${API}/v2/categories/001`,
                  gross_value: '1200.0',
                  sales_tax_rate: '20.0',
                  sales_tax_value: '200.0',
                  dated_on: '2026-10-02',
                  attachments: [],
                },
              ]
            : [],
      }),
    'GET /v2/bills': () =>
      reply({
        bills: [
          {
            url: `${API}/v2/bills/1`,
            contact: `${API}/v2/contacts/2`,
            reference: 'B-1',
            dated_on: '2026-09-01',
            due_on: '2026-09-30',
            status: 'Open',
            total_value: '60.0',
            due_value: '60.0',
          },
        ],
      }),
    'GET /v2/invoices': () =>
      reply({
        invoices: [
          {
            url: `${API}/v2/invoices/1`,
            contact: `${API}/v2/contacts/1`,
            reference: 'INV-001',
            dated_on: '2026-09-01',
            due_on: '2026-09-15',
            status: 'Open',
            total_value: '1200.0',
            paid_value: '0.0',
            due_value: '1200.0',
          },
        ],
      }),
  }
}

afterEach(() => {
  freeagentHttp.fetch = (input, init) => fetch(input, init)
})

// ---- OAuth ----------------------------------------------------------------------------------------

describe('connecting', () => {
  let tenantId: string
  let userId: string
  let cookie: Record<string, string>
  let memberCookie: Record<string, string>

  beforeAll(async () => {
    ;({ tenantId, userId, cookie } = await tenantWithOwner())
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenantId, 'member')
    memberCookie = {
      ...sessionCookieHeader(await createTestSession(db, member.id, tenantId)),
      ...ORIGIN,
    }
  })

  it('answers FreeAgent’s approve URL to an admin, never to a member, and 503s unconfigured', async () => {
    const env = freeagentEnv()
    const res = await request(
      '/api/freeagent/connect',
      { method: 'POST', headers: cookie },
      { env }
    )
    expect(res.status).toBe(200)
    const { approveUrl } = await json<{ approveUrl: string }>(res)
    const url = new URL(approveUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`${API}/v2/approve_app`)
    expect(url.searchParams.get('client_id')).toBe('test-client')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/hooks\/freeagent\/callback$/)
    expect(url.searchParams.get('state')).toBeTruthy()

    const denied = await request(
      '/api/freeagent/connect',
      { method: 'POST', headers: memberCookie },
      { env }
    )
    expect(denied.status).toBe(403)
    const bare = await request('/api/freeagent/connect', { method: 'POST', headers: cookie })
    expect(bare.status).toBe(503)
  })

  it('401s a callback whose state is missing, forged or for another purpose', async () => {
    const env = freeagentEnv()
    const config = makeJobCtx({ db, env }).config
    const wrongPurpose = await signState(config, 'something.else', { tenantId, userId })
    for (const state of ['', 'garbage', 'a.b', wrongPurpose]) {
      const res = await request(
        `/api/hooks/freeagent/callback?code=abc&state=${encodeURIComponent(state)}`,
        {},
        { env }
      )
      expect(res.status).toBe(401)
    }
    const [row] = await db
      .select()
      .from(freeagentConnections)
      .where(eq(freeagentConnections.tenantId, tenantId))
    expect(row).toBeUndefined()
  })

  it('exchanges the code, stores the tokens SEALED, records the company and queues a sync', async () => {
    const env = freeagentEnv()
    const config = makeJobCtx({ db, env }).config
    const fake = fakeFreeAgent({
      'POST /v2/token_endpoint': () => tokenReply(1),
      'GET /v2/company': () => reply(company),
    })
    freeagentHttp.fetch = fake.deps.fetch
    const state = await signState(config, CONNECT_STATE_PURPOSE, { tenantId, userId })
    const res = await request(
      `/api/hooks/freeagent/callback?code=the-code&state=${encodeURIComponent(state)}`,
      {},
      { env }
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/settings')
    expect(location.searchParams.get('tab')).toBe('freeagent')
    expect(location.searchParams.get('connected')).toBe('freeagent')

    // The token request: Basic auth with the app, the code, the same redirect URI.
    const tokenCall = fake.calls.find(c => c.url.pathname === '/v2/token_endpoint')
    expect(tokenCall?.headers.get('Authorization')).toBe(`Basic ${btoa('test-client:test-secret')}`)
    const form = new URLSearchParams(tokenCall?.body ?? '')
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('the-code')
    expect(form.get('redirect_uri')).toMatch(/\/api\/hooks\/freeagent\/callback$/)

    const [row] = await db
      .select()
      .from(freeagentConnections)
      .where(eq(freeagentConnections.tenantId, tenantId))
    expect(row).toMatchObject({
      status: 'connected',
      environment: 'sandbox',
      companyName: 'GuideMode Ltd',
      companyCurrency: 'GBP',
      connectedByUserId: userId,
    })
    expect(row?.refreshTokenEnc).not.toContain('refresh-1')
    expect(row?.accessTokenEnc).not.toContain('access-1')
    expect(await openSecret(config, row?.refreshTokenEnc ?? '')).toBe('refresh-1')
    expect(await openSecret(config, row?.accessTokenEnc ?? '')).toBe('access-1')
    expect(stubs(env).queue.messages.map(m => (m.body as { type: string }).type)).toContain(
      'freeagent.sync'
    )

    // Status never carries a token.
    const status = await request('/api/freeagent/status', { headers: memberCookie }, { env })
    const body = await status.text()
    expect(JSON.parse(body)).toMatchObject({
      configured: true,
      connected: true,
      companyName: 'GuideMode Ltd',
    })
    expect(body).not.toContain('refresh-1')
    expect(body).not.toContain('access-1')
  })

  it('sends a denied approval back to Settings with the reason', async () => {
    const env = freeagentEnv()
    const config = makeJobCtx({ db, env }).config
    const state = await signState(config, CONNECT_STATE_PURPOSE, { tenantId, userId })
    const res = await request(
      `/api/hooks/freeagent/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      {},
      { env }
    )
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('connectError')).toBe(
      'access_denied'
    )
  })
})

// ---- Tokens ---------------------------------------------------------------------------------------

describe('token refresh', () => {
  it('refreshes once near expiry (single-flight), rotating the stored refresh token', async () => {
    const { tenantId, userId } = await tenantWithOwner()
    const env = freeagentEnv()
    await connect(tenantId, userId, env, 60_000) // one minute left: inside the two-minute margin
    let refreshes = 0
    const fake = fakeFreeAgent({
      'POST /v2/token_endpoint': () => tokenReply(++refreshes),
      'GET /v2/company': ({ headers }) =>
        reply({ ...company, seenToken: headers.get('Authorization') }),
    })
    const ctx = makeJobCtx({ db, env })
    const client = await freeagentClientFor(ctx, tenantId, fake.deps)
    const answers = await Promise.all([
      client.get<{ seenToken: string }>('/v2/company'),
      client.get<{ seenToken: string }>('/v2/company'),
      client.get<{ seenToken: string }>('/v2/company'),
    ])
    expect(refreshes).toBe(1)
    expect(answers.map(a => a.seenToken)).toEqual([
      'Bearer access-1',
      'Bearer access-1',
      'Bearer access-1',
    ])
    const form = new URLSearchParams(
      fake.calls.find(c => c.url.pathname === '/v2/token_endpoint')?.body ?? ''
    )
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('refresh-0')
    const [row] = await db
      .select()
      .from(freeagentConnections)
      .where(eq(freeagentConnections.tenantId, tenantId))
    expect(await openSecret(ctx.config, row?.refreshTokenEnc ?? '')).toBe('refresh-1')
  })

  it('marks the connection needs_reconnect on invalid_grant, and the sync stops there', async () => {
    const { tenantId, userId } = await tenantWithOwner()
    const env = freeagentEnv()
    await connect(tenantId, userId, env, 0) // expired
    const fake = fakeFreeAgent({
      'POST /v2/token_endpoint': () =>
        reply({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 }),
    })
    const ctx = makeJobCtx({ db, env })
    const outcome = await syncTenant(ctx, tenantId, { deps: fake.deps, listeners: [] })
    expect(outcome.status).toBe('needs_reconnect')
    const [row] = await db
      .select()
      .from(freeagentConnections)
      .where(eq(freeagentConnections.tenantId, tenantId))
    expect(row).toMatchObject({
      status: 'needs_reconnect',
      accessTokenEnc: null,
      syncClaimedUntil: null,
    })
    expect(row?.lastError).toMatch(/reconnect/i)
    await expect(freeagentClientFor(ctx, tenantId, fake.deps)).rejects.toMatchObject({
      code: 'needs_reconnect',
    })
    // The cron no longer queues it, and no tools are offered.
    expect(await freeagentAgentTools(makeToolCtx({ db, env, tenantId }), fake.deps)).toEqual([])
  })
})

// ---- Sync -----------------------------------------------------------------------------------------

describe('sync', () => {
  it('mirrors the books, pages, writes cursors, then syncs incrementally and reconciles deletions', async () => {
    const { tenantId, userId } = await tenantWithOwner()
    const env = freeagentEnv()
    await connect(tenantId, userId, env)
    const state = { pass: 1 }
    const fake = fakeFreeAgent(booksRoutes(state))
    const ctx = makeJobCtx({ db, env })
    const heard: string[] = []
    const listener = {
      id: 'test',
      onSync: async (s: { tenantId: string }) => void heard.push(s.tenantId),
    }
    const broken = {
      id: 'broken',
      onSync: async () => {
        throw new Error('boom')
      },
    }

    const first = await syncTenant(ctx, tenantId, {
      deps: fake.deps,
      listeners: [broken, listener],
    })
    expect(first.status).toBe('synced')
    expect(heard).toEqual([tenantId]) // a throwing listener did not stop the next

    const txs = await db
      .select()
      .from(freeagentBankTransactions)
      .where(eq(freeagentBankTransactions.tenantId, tenantId))
    expect(txs.map(t => [t.url, t.amount, t.isUnexplained]).sort()).toEqual([
      [TX1, '-42.50', true],
      [TX2, '1200.00', false],
    ])
    const [exp] = await db
      .select()
      .from(freeagentExplanations)
      .where(eq(freeagentExplanations.tenantId, tenantId))
    expect(exp).toMatchObject({
      url: EXP1,
      bankTransactionUrl: TX2,
      categoryUrl: `${API}/v2/categories/001`,
      grossValue: '1200.00',
      salesTaxRate: '20.0000',
    })
    const contacts = await db
      .select()
      .from(freeagentContacts)
      .where(eq(freeagentContacts.tenantId, tenantId))
    expect(contacts.map(c => c.displayName).sort()).toEqual(['Acme Ltd', 'Rail Co']) // both pages
    expect(
      await db.select().from(freeagentCategories).where(eq(freeagentCategories.tenantId, tenantId))
    ).toHaveLength(2)
    expect(
      await db.select().from(freeagentBills).where(eq(freeagentBills.tenantId, tenantId))
    ).toHaveLength(1)
    expect(
      await db.select().from(freeagentInvoices).where(eq(freeagentInvoices.tenantId, tenantId))
    ).toHaveLength(1)

    // The first pass of transactions is bounded (from_date) and not incremental.
    const firstTxCall = fake.calls.find(c => c.url.pathname === '/v2/bank_transactions')
    expect(firstTxCall?.url.searchParams.get('bank_account')).toBe(ACCOUNT)
    expect(firstTxCall?.url.searchParams.get('from_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(firstTxCall?.url.searchParams.get('updated_since')).toBeNull()
    for (const call of fake.calls) expect(call.headers.get('X-Api-Version')).toBe('2026-09-01')

    const cursors = await db
      .select()
      .from(freeagentSyncState)
      .where(eq(freeagentSyncState.tenantId, tenantId))
    expect(cursors.map(c => c.resource).sort()).toEqual(
      [
        'bills',
        'contacts',
        'invoices',
        `bank_transaction_explanations:${ACCOUNT}`,
        `bank_transactions:${ACCOUNT}`,
      ].sort()
    )
    const [conn] = await db
      .select()
      .from(freeagentConnections)
      .where(eq(freeagentConnections.tenantId, tenantId))
    expect(conn?.lastSyncAt).toBeInstanceOf(Date)
    expect(conn?.syncClaimedUntil).toBeNull()

    // Second pass: incremental, and the explanation deleted upstream is removed here.
    state.pass = 2
    fake.calls.length = 0
    expect((await syncTenant(ctx, tenantId, { deps: fake.deps, listeners: [] })).status).toBe(
      'synced'
    )
    const secondTxCall = fake.calls.find(c => c.url.pathname === '/v2/bank_transactions')
    expect(secondTxCall?.url.searchParams.get('updated_since')).toBeTruthy()
    expect(secondTxCall?.url.searchParams.get('from_date')).toBeNull()
    const [tx2] = await db
      .select()
      .from(freeagentBankTransactions)
      .where(
        and(
          eq(freeagentBankTransactions.tenantId, tenantId),
          eq(freeagentBankTransactions.url, TX2)
        )
      )
    expect(tx2).toMatchObject({ isUnexplained: true, unexplainedAmount: '1200.00' })
    expect(
      await db
        .select()
        .from(freeagentExplanations)
        .where(eq(freeagentExplanations.tenantId, tenantId))
    ).toEqual([])
    expect(txs).toHaveLength(2)
    expect(
      await db
        .select()
        .from(freeagentBankTransactions)
        .where(eq(freeagentBankTransactions.tenantId, tenantId))
    ).toHaveLength(2)
  })

  it('skips a tenant another sync has claimed, and records a failure for the retry', async () => {
    const { tenantId, userId } = await tenantWithOwner()
    const env = freeagentEnv()
    await connect(tenantId, userId, env)
    await db
      .update(freeagentConnections)
      .set({ syncClaimedUntil: new Date(Date.now() + 60_000) })
      .where(eq(freeagentConnections.tenantId, tenantId))
    const fake = fakeFreeAgent(booksRoutes({ pass: 1 }))
    const ctx = makeJobCtx({ db, env })
    expect(await syncTenant(ctx, tenantId, { deps: fake.deps, listeners: [] })).toEqual({
      status: 'skipped',
      reason: 'claimed',
    })
    expect(fake.calls).toHaveLength(0)

    await db
      .update(freeagentConnections)
      .set({ syncClaimedUntil: null })
      .where(eq(freeagentConnections.tenantId, tenantId))
    const limited = fakeFreeAgent({
      'GET /v2/company': () => reply({}, { status: 429, headers: { 'Retry-After': '3600' } }),
    })
    await expect(
      syncTenant(ctx, tenantId, { deps: limited.deps, listeners: [] })
    ).rejects.toMatchObject({ code: 'rate_limited' })
    const [row] = await db
      .select()
      .from(freeagentConnections)
      .where(eq(freeagentConnections.tenantId, tenantId))
    expect(row).toMatchObject({
      syncClaimedUntil: null,
      lastError: 'FreeAgent rate limit reached; try again later',
    })
  })

  it('the cron queues one sync per connected organisation, through the host dispatcher', async () => {
    const { tenantId, userId } = await tenantWithOwner()
    const env = freeagentEnv()
    await connect(tenantId, userId, env)
    const queued = await enqueueSyncs(makeCronCtx({ db, env }))
    expect(queued).toBeGreaterThanOrEqual(1)
    const payloads = stubs(env).queue.messages.map(
      m => m.body as { type: string; payload: { tenantId: string } }
    )
    expect(
      payloads.filter(p => p.type === 'freeagent.sync').map(p => p.payload.tenantId)
    ).toContain(tenantId)

    // The manifest's cron (what reaches both tomls) is the expression the task is registered
    // under, and the host's dispatcher really runs it.
    const manifest = JSON.parse(
      readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8')
    ) as { crons: string[] }
    expect(manifest.crons).toEqual([FREEAGENT_CRON])
    const execution = createExecutionContext()
    const report = await dispatchScheduled(FREEAGENT_CRON, freeagentEnv(), execution)
    await waitOnExecutionContext(execution)
    expect(report).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task: 'freeagent.enqueueSyncs', status: 'ok' }),
      ])
    )
  })
})

// ---- Writes ---------------------------------------------------------------------------------------

describe('explain and attach', () => {
  it('explains a transaction, attaches a receipt, and the mirror follows both', async () => {
    const { tenantId, userId } = await tenantWithOwner()
    const env = freeagentEnv()
    await connect(tenantId, userId, env)
    const state = { pass: 1 }
    const books = fakeFreeAgent(booksRoutes(state))
    const ctx = makeJobCtx({ db, env })
    await syncTenant(ctx, tenantId, { deps: books.deps, listeners: [] })
    expect((await listUnexplainedTransactions(ctx, tenantId)).map(t => t.url)).toEqual([TX1])

    const NEW_EXP = `${API}/v2/bank_transaction_explanations/777`
    let attachments: Array<{ url: string }> = []
    const writes = fakeFreeAgent({
      'POST /v2/bank_transaction_explanations': ({ body }) => {
        const sent = JSON.parse(body ?? '{}').bank_transaction_explanation
        expect(sent).toEqual({
          bank_transaction: TX1,
          category: CATEGORY,
          gross_value: '-42.50',
          dated_on: '2026-10-01',
          description: 'Train to London',
          sales_tax_rate: '0',
        })
        return reply(
          {
            bank_transaction_explanation: {
              url: NEW_EXP,
              bank_transaction: TX1,
              bank_account: ACCOUNT,
              category: CATEGORY,
              gross_value: '-42.5',
              sales_tax_rate: '0.0',
              dated_on: '2026-10-01',
              description: 'Train to London',
              attachments: [],
            },
          },
          { status: 201 }
        )
      },
      'GET /v2/bank_transactions/101': () =>
        reply({
          bank_transaction: {
            url: TX1,
            bank_account: ACCOUNT,
            dated_on: '2026-10-01',
            amount: '-42.50',
            unexplained_amount: '0.0',
            bank_transaction_explanations: [{ url: NEW_EXP, gross_value: '-42.5' }],
          },
        }),
      'POST /v2/bank_transaction_explanations/777/attachments': ({ body }) => {
        const sent = JSON.parse(body ?? '{}')
        expect(sent.attachments).toHaveLength(1)
        expect(sent.attachments[0]).toMatchObject({
          file_name: 'receipt.pdf',
          content_type: 'application/x-pdf',
          description: 'Trainline receipt',
        })
        expect(atob(sent.attachments[0].data)).toBe('%PDF-1.4 receipt')
        attachments = [...attachments, { url: `${API}/v2/attachments/${attachments.length + 1}` }]
        return reply({ attachments }, { status: 201 })
      },
    })

    const explanation = await explainTransaction(
      ctx,
      tenantId,
      {
        bankTransactionUrl: TX1,
        categoryUrl: CATEGORY,
        grossValue: '-42.50',
        datedOn: '2026-10-01',
        description: 'Train to London',
        salesTaxRate: '0',
      },
      writes.deps
    )
    expect(explanation.url).toBe(NEW_EXP)
    const [tx1] = await db
      .select()
      .from(freeagentBankTransactions)
      .where(
        and(
          eq(freeagentBankTransactions.tenantId, tenantId),
          eq(freeagentBankTransactions.url, TX1)
        )
      )
    expect(tx1).toMatchObject({ isUnexplained: false, unexplainedAmount: '0.00' })
    expect(await listUnexplainedTransactions(ctx, tenantId)).toEqual([])

    const bytes = new TextEncoder().encode('%PDF-1.4 receipt')
    const result = await attachToExplanation(
      ctx,
      tenantId,
      NEW_EXP,
      {
        bytes,
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
        description: 'Trainline receipt',
      },
      writes.deps
    )
    expect(result.attachmentCount).toBe(1)
    const [mirrored] = await db
      .select()
      .from(freeagentExplanations)
      .where(
        and(eq(freeagentExplanations.tenantId, tenantId), eq(freeagentExplanations.url, NEW_EXP))
      )
    expect(mirrored).toMatchObject({
      categoryUrl: CATEGORY,
      grossValue: '-42.50',
      attachmentCount: 1,
    })

    // Refused before any bytes leave: wrong type, too big, or a URL off the connection's host.
    await expect(
      attachToExplanation(
        ctx,
        tenantId,
        NEW_EXP,
        { bytes, filename: 'x.docx', contentType: 'application/msword' },
        writes.deps
      )
    ).rejects.toMatchObject({ code: 'validation' })
    await expect(
      attachToExplanation(
        ctx,
        tenantId,
        NEW_EXP,
        {
          bytes: new Uint8Array(5 * 1024 * 1024 + 1),
          filename: 'big.png',
          contentType: 'image/png',
        },
        writes.deps
      )
    ).rejects.toMatchObject({ code: 'validation' })
    await expect(
      explainTransaction(
        ctx,
        tenantId,
        {
          bankTransactionUrl: 'https://evil.example/v2/bank_transactions/1',
          categoryUrl: CATEGORY,
          grossValue: '-1',
          datedOn: '2026-10-01',
          description: 'x',
        },
        writes.deps
      )
    ).rejects.toMatchObject({ code: 'validation' })
    await expect(
      explainTransaction(
        ctx,
        tenantId,
        {
          bankTransactionUrl: TX1,
          categoryUrl: CATEGORY,
          grossValue: 'twelve',
          datedOn: '2026-10-01',
          description: 'x',
        },
        writes.deps
      )
    ).rejects.toMatchObject({ code: 'validation' })
  })
})

// ---- Tools ----------------------------------------------------------------------------------------

describe('agent tools', () => {
  it('offers nothing until connected; read tools to everyone, write tools to admins only', async () => {
    const { tenantId, userId } = await tenantWithOwner()
    const env = freeagentEnv()
    expect(await freeagentAgentTools(makeToolCtx({ db, env, tenantId }))).toEqual([])
    await connect(tenantId, userId, env)
    // Configured AND connected: connected alone, on a deployment without the app, is not enough.
    expect(await freeagentAgentTools(makeToolCtx({ db, tenantId }))).toEqual([])

    const admin = await freeagentAgentTools(makeToolCtx({ db, env, tenantId, bypass: true }))
    expect(admin.map(t => t.name).sort()).toEqual(Object.values(FREEAGENT_TOOL_NAMES).sort())
    for (const t of admin) {
      const writes =
        t.name === FREEAGENT_TOOL_NAMES.explainTransaction ||
        t.name === FREEAGENT_TOOL_NAMES.createBill
      expect(Boolean(t.requiresApproval), t.name).toBe(writes)
    }
    const member = await freeagentAgentTools(
      makeToolCtx({ db, env, tenantId, bypass: false, userId })
    )
    expect(member.map(t => t.name)).not.toContain(FREEAGENT_TOOL_NAMES.explainTransaction)
    expect(member.map(t => t.name)).toContain(FREEAGENT_TOOL_NAMES.searchTransactions)

    await syncTenant(makeJobCtx({ db, env }), tenantId, {
      deps: fakeFreeAgent(booksRoutes({ pass: 1 })).deps,
      listeners: [],
    })
    const search = member.find(t => t.name === FREEAGENT_TOOL_NAMES.searchTransactions)
    const out = JSON.parse((await search?.handler?.({ unexplainedOnly: true })) ?? '{}')
    expect(out.transactions.map((t: { url: string }) => t.url)).toEqual([TX1])
    const invoices = member.find(t => t.name === FREEAGENT_TOOL_NAMES.listInvoices)
    const overdue = JSON.parse((await invoices?.handler?.({ overdueOnly: true })) ?? '{}')
    expect(overdue.invoices).toEqual([
      expect.objectContaining({ reference: 'INV-001', overdue: true, contact: 'Acme Ltd' }),
    ])
  })
})

// ---- Tenant isolation -----------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('another organisation can neither read nor change anything through the mounts', async () => {
    const a = await tenantWithOwner()
    // The second organisation, built inline so the shape of the proof is visible here.
    const otherTenantId = (await createTestTenant(db)).id
    const outsider = await createTestUser(db)
    await linkUserToTenant(db, outsider.id, otherTenantId, 'owner')
    const b = {
      tenantId: otherTenantId,
      userId: outsider.id,
      cookie: {
        ...sessionCookieHeader(await createTestSession(db, outsider.id, otherTenantId)),
        ...ORIGIN,
      },
    }
    const env = freeagentEnv()
    await connect(a.tenantId, a.userId, env)
    await syncTenant(makeJobCtx({ db, env }), a.tenantId, {
      deps: fakeFreeAgent(booksRoutes({ pass: 1 })).deps,
      listeners: [],
    })

    // A sees its books.
    const mine = await json<{ items: { url: string }[] }>(
      await request('/api/freeagent/transactions', { headers: a.cookie }, { env })
    )
    expect(mine.items.map(t => t.url).sort()).toEqual([TX1, TX2])

    // B sees nothing of A's, and is not connected.
    const status = await json<{
      connected: boolean
      companyName: string | null
      counts: { transactions: number }
    }>(await request('/api/freeagent/status', { headers: b.cookie }, { env }))
    expect(status).toMatchObject({
      connected: false,
      companyName: null,
      counts: { transactions: 0 },
    })
    for (const path of [
      '/api/freeagent/transactions',
      '/api/freeagent/transactions?unexplained=true',
      '/api/freeagent/invoices',
    ]) {
      const list = await json<{ items: unknown[] }>(
        await request(path, { headers: b.cookie }, { env })
      )
      expect(list.items, path).toEqual([])
    }

    // B can neither disconnect nor sync A.
    expect(
      (await request('/api/freeagent/connection', { method: 'DELETE', headers: b.cookie }, { env }))
        .status
    ).toBe(404)
    expect(
      (await request('/api/freeagent/sync', { method: 'POST', headers: b.cookie }, { env })).status
    ).toBe(404)
    const [stillA] = await db
      .select()
      .from(freeagentConnections)
      .where(eq(freeagentConnections.tenantId, a.tenantId))
    expect(stillA?.status).toBe('connected')
    expect(
      await db
        .select()
        .from(freeagentBankTransactions)
        .where(eq(freeagentBankTransactions.tenantId, a.tenantId))
    ).toHaveLength(2)

    // A's state cannot be replayed into B's callback either: a state names its tenant.
    const config = makeJobCtx({ db, env }).config
    const forged = await signState(config, CONNECT_STATE_PURPOSE, {
      tenantId: 'not-a-uuid',
      userId: b.userId,
    })
    expect(
      (
        await request(
          `/api/hooks/freeagent/callback?code=x&state=${encodeURIComponent(forged)}`,
          {},
          { env }
        )
      ).status
    ).toBe(401)

    // A's own disconnect removes A's tokens and mirror — and only A's.
    expect(
      (await request('/api/freeagent/connection', { method: 'DELETE', headers: a.cookie }, { env }))
        .status
    ).toBe(204)
    expect(
      await db
        .select()
        .from(freeagentBankTransactions)
        .where(eq(freeagentBankTransactions.tenantId, a.tenantId))
    ).toEqual([])
  })
})
