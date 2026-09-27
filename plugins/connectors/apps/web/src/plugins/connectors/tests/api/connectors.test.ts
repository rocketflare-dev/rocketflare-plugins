// @vitest-isolate
/**
 * Isolated because it swaps the provider registry for a fixture, which must not leak into another
 * file sharing this worker.
 *
 * The connectors plugin on real Postgres, against a FAKE vendor: the routes (roles, no secrets
 * out), the public consent callback (signed state or nothing), the sync engine (paging, cursors,
 * claims, full passes and their sweeps, throttling, revoked consent), member matching, the
 * per-person visibility of calendar events, disconnect, the cron — and tenant isolation.
 *
 * The provider registry is replaced with `fakeProvider` for this file, so the suite proves the
 * engine whether or not any real provider plugin is installed beside it.
 */
import { CONNECTORS_FLAG, CONNECTORS_SYNC_JOB } from '@rocketflare/shared/plugins/connectors/index'
import {
  createTestEnv,
  createTestSession,
  createTestTenant,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
  stubs,
} from '@testkit/integration'
import { makeCronCtx, makeJobCtx } from '@testkit/unit'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { signState } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { CONSENT_STATE_PURPOSE } from '../../api/consent'
import { enqueueDueSyncs } from '../../api/scheduled'
import {
  connectorsCalendarEvents,
  connectorsConnections,
  connectorsDirectoryGroups,
  connectorsDirectoryUsers,
  connectorsGroupMembers,
  connectorsInstallations,
  connectorsSyncCursors,
} from '../../db/schema'
import {
  type CalendarEventItem,
  ConnectorAuthError,
  type ConnectorProvider,
  ConsentError,
  CursorExpiredError,
  type DirectoryUserItem,
  RetryLaterError,
  type SyncPage,
  setConnectorProvidersForTests,
} from '../../providers'
import { runSync } from '../../services/sync'

const db = setupTestDatabase()
const BASE = '/api/connectors'
const EXTERNAL_TENANT = '11111111-2222-4333-8444-555555555555'

// ---- The fake vendor ------------------------------------------------------------------------------

/** What the fake answers next. Tests mutate it; `beforeEach` resets it. */
const script = {
  mints: 0,
  /** Thrown by the NEXT source call, then cleared. */
  failNext: null as Error | null,
  users: new Map<string | null, SyncPage<DirectoryUserItem>>(),
  events: new Map<string, (cursor: string | null) => SyncPage<CalendarEventItem>>(),
}

function empty<T>(final: string): SyncPage<T> {
  return { items: [], removed: [], next: null, final }
}

function takeFailure() {
  const err = script.failNext
  script.failNext = null
  if (err) throw err
}

function event(id: string, title: string, day = 1): CalendarEventItem {
  const startsAt = new Date(Date.now() + day * 86_400_000)
  return {
    externalId: id,
    title,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    isAllDay: false,
    location: null,
    organizerEmail: null,
    organizerName: null,
    attendees: [],
    webLink: null,
    isCancelled: false,
  }
}

const fakeProvider: ConnectorProvider = {
  id: 'fake',
  label: 'Fake Suite',
  description: 'A vendor that exists only in this test file.',
  docsUrl: null,
  adminSteps: ['Press connect.'],
  operatorSteps: ['None.'],
  permissions: [{ scope: 'Everything.Read', reason: 'tests' }],
  supportsByo: true,
  tokenPerSubject: false,
  operatorCredentials: () => ({ clientId: 'operator-client', clientSecret: 'operator-secret' }),
  consentUrl: ({ credentials, redirectUri, state }) =>
    `https://consent.example.test/?client_id=${credentials.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  completeConsent: ({ query }) => {
    if (query.get('ok') !== '1') throw new ConsentError('Cancelled', 'consent_not_granted')
    return { externalTenantId: query.get('tenant') ?? EXTERNAL_TENANT, displayName: 'Contoso' }
  },
  mintToken: async () => {
    script.mints++
    return {
      accessToken: `token-${script.mints}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['Everything.Read'],
    }
  },
  directory: {
    users: async (ctx, cursor) => {
      await ctx.token()
      takeFailure()
      return script.users.get(cursor) ?? empty('users-delta-idle')
    },
    groups: async (ctx, cursor) => {
      await ctx.token()
      takeFailure()
      if (cursor === null) {
        return {
          items: [
            {
              externalId: 'g-eng',
              displayName: 'Engineering',
              email: 'ENG@contoso.test',
              description: null,
              members: { mode: 'delta', added: ['u-alice', 'u-bob'], removed: [] },
            },
          ],
          removed: [],
          next: null,
          final: 'groups-delta-1',
        }
      }
      return empty('groups-delta-1')
    },
  },
  calendar: {
    windowDays: { past: 30, future: 90 },
    maxChainDays: 7,
    events: async (ctx, cursor) => {
      await ctx.token()
      takeFailure()
      const answer = script.events.get(ctx.subject.externalId)
      return answer ? answer(cursor) : empty(`events-${ctx.subject.externalId}`)
    },
  },
}

// ---- Fixtures -------------------------------------------------------------------------------------

let tenantId: string
let otherTenantId: string
let ownerId: string
let aliceId: string
let bobId: string
let ownerCookie: Record<string, string>
let aliceCookie: Record<string, string>
let bobCookie: Record<string, string>
let otherCookie: Record<string, string>

const suffix = crypto.randomUUID().slice(0, 8)
const aliceEmail = `alice-${suffix}@contoso.test`
const bobEmail = `bob-${suffix}@contoso.test`

async function member(email: string, role: 'owner' | 'member', tenant: string) {
  const user = await createTestUser(db, { email })
  await linkUserToTenant(db, user.id, tenant, role)
  return { id: user.id, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant)) }
}

function jobCtx() {
  const env = createTestEnv()
  return { env, ctx: makeJobCtx({ db, env }) }
}

/** Connect the fake provider for `tenant` the way a browser would: start, then the callback. */
async function connect(cookie: Record<string, string>, tenant: string, env = createTestEnv()) {
  const started = await request(
    `${BASE}/installations`,
    { method: 'POST', headers: cookie },
    { json: { provider: 'fake' }, env }
  )
  expect(started.status).toBe(201)
  const { installationId, consentUrl } = await json<{ installationId: string; consentUrl: string }>(
    started
  )
  const state = new URL(consentUrl).searchParams.get('state') ?? ''
  const back = await request(
    `/api/hooks/connectors/fake/callback?ok=1&tenant=${EXTERNAL_TENANT}&state=${state}`,
    {},
    { env }
  )
  expect(back.status).toBe(302)
  expect(back.headers.get('location')).toContain('connected=fake')
  const [row] = await db
    .select()
    .from(connectorsInstallations)
    .where(
      and(
        eq(connectorsInstallations.id, installationId),
        eq(connectorsInstallations.tenantId, tenant)
      )
    )
  return row
}

async function cursorsOf(tenant: string, resource: string) {
  return db
    .select()
    .from(connectorsSyncCursors)
    .where(
      and(eq(connectorsSyncCursors.tenantId, tenant), eq(connectorsSyncCursors.resource, resource))
    )
}

/** Run a cursor's job until the pass ends (the engine hands over after ten pages). */
async function drain(tenant: string, cursorId: string) {
  const { ctx } = jobCtx()
  for (let i = 0; i < 5; i++) {
    const outcome = await runSync(ctx, { tenantId: tenant, cursorId })
    if (outcome.kind !== 'continued' && outcome.kind !== 'reset') return outcome
  }
  throw new Error('the pass never finished')
}

beforeAll(async () => {
  setConnectorProvidersForTests([fakeProvider])
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id
  const owner = await member(`owner-${suffix}@example.test`, 'owner', tenantId)
  ownerId = owner.id
  ownerCookie = owner.cookie
  const alice = await member(aliceEmail, 'member', tenantId)
  aliceId = alice.id
  aliceCookie = alice.cookie
  const bob = await member(bobEmail, 'member', tenantId)
  bobId = bob.id
  bobCookie = bob.cookie
  otherCookie = (await member(`outsider-${suffix}@example.test`, 'owner', otherTenantId)).cookie
})

afterAll(async () => {
  setConnectorProvidersForTests(null)
  const { tenantFeatureOverrides } = allTables()
  await db
    .delete(tenantFeatureOverrides)
    .where(
      and(
        eq(tenantFeatureOverrides.flagKey, CONNECTORS_FLAG),
        inArray(tenantFeatureOverrides.tenantId, [tenantId, otherTenantId])
      )
    )
})

beforeEach(() => {
  script.failNext = null
  script.users = new Map<string | null, SyncPage<DirectoryUserItem>>([
    [
      null,
      {
        items: [
          {
            externalId: 'u-alice',
            email: aliceEmail.toUpperCase(),
            displayName: 'Alice',
            jobTitle: null,
            accountEnabled: true,
          },
          {
            externalId: 'u-bob',
            email: bobEmail,
            displayName: 'Bob',
            jobTitle: null,
            accountEnabled: true,
          },
        ],
        removed: [],
        next: 'users-page-2',
        final: null,
      },
    ],
    [
      'users-page-2',
      {
        items: [
          // In the customer's directory but not a member here: synced, never calendared.
          {
            externalId: 'u-carol',
            email: `carol-${suffix}@contoso.test`,
            displayName: 'Carol',
            jobTitle: null,
            accountEnabled: true,
          },
        ],
        removed: [],
        next: null,
        final: 'users-delta-1',
      },
    ],
  ])
  script.events = new Map([
    [
      'u-alice',
      () => ({ items: [event('e-a1', 'Alice standup')], removed: [], next: null, final: 'ev-a-1' }),
    ],
    [
      'u-bob',
      () => ({ items: [event('e-b1', 'Bob 1:1')], removed: [], next: null, final: 'ev-b-1' }),
    ],
  ])
})

// ---- Routes ----------------------------------------------------------------------------------------

describe('routes', () => {
  it('401 without a session, 403 for a member on the admin surface', async () => {
    expect((await request(`${BASE}/installations`)).status).toBe(401)
    expect((await request(`${BASE}/installations`, { headers: aliceCookie })).status).toBe(403)
    const start = await request(
      `${BASE}/installations`,
      { method: 'POST', headers: aliceCookie },
      { json: { provider: 'fake' } }
    )
    expect(start.status).toBe(403)
  })

  it('lists the contributed providers for an admin, without the operator’s steps', async () => {
    const res = await request(`${BASE}/providers`, { headers: ownerCookie })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({
      items: [
        {
          id: 'fake',
          operatorConfigured: true,
          resources: ['users', 'groups', 'calendar'],
          adminSteps: ['Press connect.'],
          // A tenant admin cannot act on the deployment's setup, so it is not sent at all.
          operatorSteps: [],
          redirectUri: expect.stringMatching(/\/api\/hooks\/connectors\/fake\/callback$/),
        },
      ],
      viewer: { isOperator: false },
    })
    // Configured is a boolean; the credential behind it never travels.
    expect(text).not.toContain('operator-client')
    expect(text).not.toContain('operator-secret')
  })

  it('sends the operator’s steps to a platform operator (global admin) only', async () => {
    const operator = await createTestUser(db, {
      email: `operator-${suffix}@example.test`,
      isGlobalAdmin: true,
    })
    await linkUserToTenant(db, operator.id, tenantId, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, operator.id, tenantId))
    const res = await request(`${BASE}/providers`, { headers: cookie })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({
      items: [{ id: 'fake', operatorSteps: ['None.'] }],
      viewer: { isOperator: true },
    })
    expect(text).not.toContain('operator-secret')
  })

  it('404s an unknown provider, and seals a BYO secret without ever returning it', async () => {
    const unknown = await request(
      `${BASE}/installations`,
      { method: 'POST', headers: otherCookie },
      { json: { provider: 'nope' } }
    )
    expect(unknown.status).toBe(404)

    const byo = await request(
      `${BASE}/installations`,
      { method: 'POST', headers: otherCookie },
      {
        json: {
          provider: 'fake',
          appMode: 'byo',
          clientId: 'their-app',
          clientSecret: 'their-secret-xyz',
        },
      }
    )
    expect(byo.status).toBe(201)
    const { consentUrl } = await json<{ consentUrl: string }>(byo)
    expect(consentUrl).toContain('client_id=their-app')
    const [row] = await db
      .select()
      .from(connectorsInstallations)
      .where(eq(connectorsInstallations.tenantId, otherTenantId))
    expect(row?.byoSecretEnc).toBeTruthy()
    expect(row?.byoSecretEnc).not.toContain('their-secret-xyz')
    const list = await request(`${BASE}/installations`, { headers: otherCookie })
    const text = await list.text()
    expect(text).not.toContain('their-secret-xyz')
    expect(JSON.parse(text)).toMatchObject({
      items: [{ status: 'pending', appMode: 'byo', hasCredential: true }],
    })
    await db
      .delete(connectorsInstallations)
      .where(eq(connectorsInstallations.tenantId, otherTenantId))
  })
})

describe('the consent callback', () => {
  it('refuses a tampered, foreign-purpose or cross-provider state', async () => {
    const env = createTestEnv()
    const config = makeJobCtx({ db, env }).config
    const forged = await signState(config, 'something.else', {
      tenantId,
      userId: ownerId,
      provider: 'fake',
      installationId: crypto.randomUUID(),
    })
    for (const state of ['garbage', `${forged}x`, forged]) {
      const res = await request(
        `/api/hooks/connectors/fake/callback?ok=1&state=${state}`,
        {},
        { env }
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('connectError=invalid_state')
    }
    const right = await signState(config, CONSENT_STATE_PURPOSE, {
      tenantId,
      userId: ownerId,
      provider: 'fake',
      installationId: crypto.randomUUID(),
    })
    const other = await request(
      `/api/hooks/connectors/m365/callback?ok=1&state=${right}`,
      {},
      { env }
    )
    expect(other.headers.get('location')).toContain('connectError=invalid_state')
  })

  it('reports a refused consent and leaves the installation pending', async () => {
    const started = await request(
      `${BASE}/installations`,
      { method: 'POST', headers: ownerCookie },
      { json: { provider: 'fake' } }
    )
    const { consentUrl, installationId } = await json<{
      consentUrl: string
      installationId: string
    }>(started)
    const state = new URL(consentUrl).searchParams.get('state')
    const res = await request(`/api/hooks/connectors/fake/callback?state=${state}`)
    expect(res.headers.get('location')).toContain('connectError=consent_not_granted')
    const [row] = await db
      .select()
      .from(connectorsInstallations)
      .where(
        and(
          eq(connectorsInstallations.id, installationId),
          eq(connectorsInstallations.tenantId, tenantId)
        )
      )
    expect(row?.status).toBe('pending')
  })

  it('activates the installation, creates the organisation cursors and enqueues them', async () => {
    const env = createTestEnv()
    const row = await connect(ownerCookie, tenantId, env)
    expect(row).toMatchObject({
      status: 'active',
      externalTenantId: EXTERNAL_TENANT,
      displayName: 'Contoso',
    })
    const users = await cursorsOf(tenantId, 'users')
    const groups = await cursorsOf(tenantId, 'groups')
    expect(users).toHaveLength(1)
    expect(groups).toHaveLength(1)
    const sent = stubs(env).queue.messages.map(
      m => m.body as { type: string; payload: { cursorId: string } }
    )
    expect(
      sent
        .filter(m => m.type === CONNECTORS_SYNC_JOB)
        .map(m => m.payload.cursorId)
        .sort()
    ).toEqual([users[0]?.id, groups[0]?.id].sort())
  })
})

// ---- The engine --------------------------------------------------------------------------------------

describe('sync engine', () => {
  it('pages the directory, stores the delta token, matches members and queues their calendars', async () => {
    const [users] = await cursorsOf(tenantId, 'users')
    if (!users) throw new Error('no users cursor')
    const { ctx, env } = jobCtx()
    const outcome = await runSync(ctx, { tenantId, cursorId: users.id })
    expect(outcome).toMatchObject({ kind: 'done', pages: 2, items: 3 })

    const [after] = await cursorsOf(tenantId, 'users')
    expect(after).toMatchObject({
      cursor: 'users-delta-1',
      inProgress: false,
      fullPass: false,
      generation: 1,
    })
    expect(after?.claimedUntil).toBeNull()

    const people = await db
      .select()
      .from(connectorsDirectoryUsers)
      .where(eq(connectorsDirectoryUsers.tenantId, tenantId))
    const byExt = Object.fromEntries(people.map(p => [p.externalId, p]))
    // Lower-cased on the way in, and matched to the member with that address.
    expect(byExt['u-alice']).toMatchObject({ email: aliceEmail, matchedUserId: aliceId })
    expect(byExt['u-bob']?.matchedUserId).toBe(bobId)
    expect(byExt['u-carol']?.matchedUserId).toBeNull()

    // Two mailboxes (Alice, Bob), not Carol — and their calendar cursors went straight on the queue.
    const calendars = await cursorsOf(tenantId, 'calendar')
    expect(calendars).toHaveLength(2)
    const queued = stubs(env).queue.messages.map(
      m => (m.body as { payload: { cursorId: string } }).payload.cursorId
    )
    expect(queued.sort()).toEqual(calendars.map(c => c.id).sort())
  })

  it('caches the token across jobs rather than minting per run', async () => {
    const mints = script.mints
    const [groups] = await cursorsOf(tenantId, 'groups')
    if (!groups) throw new Error('no groups cursor')
    expect(await drain(tenantId, groups.id)).toMatchObject({ kind: 'done' })
    expect(script.mints).toBe(mints)
    const members = await db
      .select()
      .from(connectorsGroupMembers)
      .where(eq(connectorsGroupMembers.tenantId, tenantId))
    expect(members.map(m => m.userExternalId).sort()).toEqual(['u-alice', 'u-bob'])
    const [group] = await db
      .select()
      .from(connectorsDirectoryGroups)
      .where(eq(connectorsDirectoryGroups.tenantId, tenantId))
    expect(group).toMatchObject({ externalId: 'g-eng', email: 'eng@contoso.test' })
  })

  it('syncs each mailbox into events owned by its member', async () => {
    for (const cursor of await cursorsOf(tenantId, 'calendar')) {
      expect(await drain(tenantId, cursor.id)).toMatchObject({ kind: 'done' })
    }
    const events = await db
      .select()
      .from(connectorsCalendarEvents)
      .where(eq(connectorsCalendarEvents.tenantId, tenantId))
    expect(events.map(e => [e.externalId, e.ownerUserId]).sort()).toEqual([
      ['e-a1', aliceId],
      ['e-b1', bobId],
    ])
  })

  it('applies a partial delta without erasing what it did not mention', async () => {
    script.users.set('users-delta-1', {
      items: [{ externalId: 'u-bob', jobTitle: 'Engineer' }],
      removed: [],
      next: null,
      final: 'users-delta-2',
    })
    const [users] = await cursorsOf(tenantId, 'users')
    if (!users) throw new Error('no users cursor')
    expect(await drain(tenantId, users.id)).toMatchObject({ kind: 'done', items: 1 })
    const [bob] = await db
      .select()
      .from(connectorsDirectoryUsers)
      .where(
        and(
          eq(connectorsDirectoryUsers.tenantId, tenantId),
          eq(connectorsDirectoryUsers.externalId, 'u-bob')
        )
      )
    expect(bob).toMatchObject({
      jobTitle: 'Engineer',
      displayName: 'Bob',
      email: bobEmail,
      matchedUserId: bobId,
    })
  })

  it('an expired cursor restarts a FULL pass, whose end sweeps what it did not see', async () => {
    const calendars = await db
      .select({ cursor: connectorsSyncCursors, subject: connectorsConnections.subject })
      .from(connectorsSyncCursors)
      .innerJoin(
        connectorsConnections,
        eq(connectorsConnections.id, connectorsSyncCursors.connectionId)
      )
      .where(
        and(
          eq(connectorsSyncCursors.tenantId, tenantId),
          eq(connectorsSyncCursors.resource, 'calendar')
        )
      )
    const alice = calendars.find(c => c.subject === 'u-alice')?.cursor
    if (!alice) throw new Error('no alice cursor')
    // The full pass now returns a DIFFERENT event: e-a1 was deleted while the token was dead.
    script.events.set('u-alice', cursor =>
      cursor === null
        ? { items: [event('e-a2', 'Alice planning')], removed: [], next: null, final: 'ev-a-2' }
        : empty('ev-a-2')
    )
    script.failNext = new CursorExpiredError()
    const { ctx } = jobCtx()
    expect(await runSync(ctx, { tenantId, cursorId: alice.id })).toEqual({ kind: 'reset' })
    expect(await drain(tenantId, alice.id)).toMatchObject({ kind: 'done' })
    const events = await db
      .select()
      .from(connectorsCalendarEvents)
      .where(
        and(
          eq(connectorsCalendarEvents.tenantId, tenantId),
          eq(connectorsCalendarEvents.ownerUserId, aliceId)
        )
      )
    expect(events.map(e => e.externalId)).toEqual(['e-a2'])
    const [after] = await db
      .select()
      .from(connectorsSyncCursors)
      .where(eq(connectorsSyncCursors.id, alice.id))
    expect(after?.generation).toBe(alice.generation + 1)
  })

  it('a throttled page releases the cursor and re-schedules it, without recording a failure', async () => {
    const [users] = await cursorsOf(tenantId, 'users')
    if (!users) throw new Error('no users cursor')
    script.failNext = new RetryLaterError(42)
    const { ctx, env } = jobCtx()
    expect(await runSync(ctx, { tenantId, cursorId: users.id })).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 42,
    })
    const [after] = await cursorsOf(tenantId, 'users')
    expect(after).toMatchObject({ claimedUntil: null, lastError: null })
    expect(stubs(env).queue.messages).toHaveLength(1)
  })

  it('a second job for a claimed cursor leaves without touching it', async () => {
    const [users] = await cursorsOf(tenantId, 'users')
    if (!users) throw new Error('no users cursor')
    await db
      .update(connectorsSyncCursors)
      .set({ claimedUntil: new Date(Date.now() + 60_000) })
      .where(eq(connectorsSyncCursors.id, users.id))
    const { ctx } = jobCtx()
    expect(await runSync(ctx, { tenantId, cursorId: users.id })).toMatchObject({ kind: 'skipped' })
    await db
      .update(connectorsSyncCursors)
      .set({ claimedUntil: null })
      .where(eq(connectorsSyncCursors.id, users.id))
  })

  it('an unexpected failure is recorded on the cursor and rethrown for the queue to retry', async () => {
    const [users] = await cursorsOf(tenantId, 'users')
    if (!users) throw new Error('no users cursor')
    script.failNext = new Error('socket hang up with Bearer abc.def.ghi')
    const { ctx } = jobCtx()
    await expect(runSync(ctx, { tenantId, cursorId: users.id })).rejects.toThrow('socket hang up')
    const [after] = await cursorsOf(tenantId, 'users')
    expect(after?.lastError).toContain('Bearer [redacted]')
    expect(after?.claimedUntil).toBeNull()
  })
})

// ---- Visibility ---------------------------------------------------------------------------------------

describe('calendar visibility', () => {
  const window = () => {
    const from = new Date(Date.now() - 86_400_000).toISOString()
    const to = new Date(Date.now() + 10 * 86_400_000).toISOString()
    return `from=${from}&to=${to}`
  }

  it('a member reads only their own events, whatever they ask for', async () => {
    for (const q of ['', '&scope=all', `&userId=${aliceId}`]) {
      const res = await request(`${BASE}/events?${window()}${q}`, { headers: bobCookie })
      expect(res.status).toBe(200)
      const body = await json<{ items: { ownerUserId: string; title: string }[] }>(res)
      expect(body.items.map(e => e.title)).toEqual(['Bob 1:1'])
    }
  })

  it('an admin may widen to the organisation, or narrow to one person', async () => {
    const all = await json<{ items: { title: string }[] }>(
      await request(`${BASE}/events?${window()}&scope=all`, { headers: ownerCookie })
    )
    expect(all.items.map(e => e.title).sort()).toEqual(['Alice planning', 'Bob 1:1'])
    const one = await json<{ items: { title: string }[] }>(
      await request(`${BASE}/events?${window()}&userId=${aliceId}`, { headers: ownerCookie })
    )
    expect(one.items.map(e => e.title)).toEqual(['Alice planning'])
    // The owner has no mailbox of their own, so "mine" is empty for them.
    const mine = await json<{ items: unknown[] }>(
      await request(`${BASE}/events?${window()}`, { headers: ownerCookie })
    )
    expect(mine.items).toEqual([])
  })

  it('refuses a window longer than the contract allows', async () => {
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 100 * 86_400_000).toISOString()
    expect(
      (await request(`${BASE}/events?from=${from}&to=${to}`, { headers: aliceCookie })).status
    ).toBe(400)
  })

  it('a member who leaves the organisation loses their mailbox and its events on the next reconcile', async () => {
    const { tenantUsers } = allTables()
    await db
      .delete(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, bobId)))
    const cron = makeCronCtx({ db })
    await enqueueDueSyncs(cron)
    const events = await db
      .select()
      .from(connectorsCalendarEvents)
      .where(
        and(
          eq(connectorsCalendarEvents.tenantId, tenantId),
          eq(connectorsCalendarEvents.ownerUserId, bobId)
        )
      )
    expect(events).toEqual([])
    expect(await cursorsOf(tenantId, 'calendar')).toHaveLength(1)
    await linkUserToTenant(db, bobId, tenantId, 'member')
  })
})

// ---- The cron ---------------------------------------------------------------------------------------

describe('the quarter-hour cron', () => {
  it('enqueues due cursors, and nothing for a tenant with the flag off', async () => {
    await db
      .update(connectorsSyncCursors)
      .set({ lastSyncedAt: new Date(0) })
      .where(eq(connectorsSyncCursors.tenantId, tenantId))
    const env = createTestEnv()
    const queued = await enqueueDueSyncs(makeCronCtx({ db, env }))
    expect(queued).toBeGreaterThanOrEqual(3)

    const { featureFlags, tenantFeatureOverrides } = allTables()
    await db
      .insert(featureFlags)
      .values({ key: CONNECTORS_FLAG, state: 'on' })
      .onConflictDoNothing()
    await db
      .insert(tenantFeatureOverrides)
      .values({ tenantId, flagKey: CONNECTORS_FLAG, enabled: false })
      .onConflictDoUpdate({
        target: [tenantFeatureOverrides.tenantId, tenantFeatureOverrides.flagKey],
        set: { enabled: false },
      })
    const env2 = createTestEnv()
    await enqueueDueSyncs(makeCronCtx({ db, env: env2 }))
    const mine = stubs(env2).queue.messages.filter(
      m => (m.body as { payload: { tenantId: string } }).payload.tenantId === tenantId
    )
    expect(mine).toEqual([])
    await db
      .delete(tenantFeatureOverrides)
      .where(
        and(
          eq(tenantFeatureOverrides.tenantId, tenantId),
          eq(tenantFeatureOverrides.flagKey, CONNECTORS_FLAG)
        )
      )
  })
})

// ---- Isolation, revocation, disconnect -----------------------------------------------------------------

describe('tenant isolation', () => {
  it('never lets another organisation see, sync or disconnect this one’s connection', async () => {
    const [mine] = await db
      .select()
      .from(connectorsInstallations)
      .where(eq(connectorsInstallations.tenantId, tenantId))
    if (!mine) throw new Error('no installation')

    const list = await json<{ items: unknown[] }>(
      await request(`${BASE}/installations`, { headers: otherCookie })
    )
    expect(list.items).toEqual([])
    // Even as an admin of THEIR organisation, `scope=all` is their organisation, never ours.
    const narrow = await json<{ items: unknown[] }>(
      await request(
        `${BASE}/events?from=${new Date().toISOString()}&to=${new Date(Date.now() + 30 * 86_400_000).toISOString()}&scope=all`,
        { headers: otherCookie }
      )
    )
    expect(narrow.items).toEqual([])
    const directory = await json<{ items: unknown[] }>(
      await request(`${BASE}/directory/users?installationId=${mine.id}`, { headers: otherCookie })
    )
    expect(directory.items).toEqual([])
    const sync = await request(
      `${BASE}/installations/${mine.id}/sync`,
      { method: 'POST', headers: otherCookie },
      { json: {} }
    )
    expect(sync.status).toBe(404)
    const del = await request(`${BASE}/installations/${mine.id}`, {
      method: 'DELETE',
      headers: otherCookie,
    })
    expect(del.status).toBe(404)
    const [still] = await db
      .select()
      .from(connectorsInstallations)
      .where(eq(connectorsInstallations.id, mine.id))
    expect(still).toBeDefined()
  })

  it('a job carrying another tenant’s id finds nothing', async () => {
    const [users] = await cursorsOf(tenantId, 'users')
    if (!users) throw new Error('no users cursor')
    const { ctx } = jobCtx()
    expect(await runSync(ctx, { tenantId: otherTenantId, cursorId: users.id })).toMatchObject({
      kind: 'skipped',
    })
  })
})

describe('revoked consent and disconnect', () => {
  it('a refused app puts the installation in error, and "Sync now" retries it', async () => {
    const [users] = await cursorsOf(tenantId, 'users')
    if (!users) throw new Error('no users cursor')
    script.failNext = new ConnectorAuthError('consent revoked')
    const { ctx } = jobCtx()
    expect(await runSync(ctx, { tenantId, cursorId: users.id })).toMatchObject({
      kind: 'auth_failed',
    })
    const [row] = await db
      .select()
      .from(connectorsInstallations)
      .where(eq(connectorsInstallations.tenantId, tenantId))
    expect(row).toMatchObject({ status: 'error', lastError: 'consent revoked' })
    // An `error` installation is not synced by a job enqueued meanwhile…
    expect(await runSync(ctx, { tenantId, cursorId: users.id })).toMatchObject({ kind: 'skipped' })
    // …until an admin presses Sync now.
    const res = await request(
      `${BASE}/installations/${row?.id}/sync`,
      { method: 'POST', headers: ownerCookie },
      { json: { resource: 'users' } }
    )
    expect(res.status).toBe(202)
    expect(await json(res)).toEqual({ queued: 1 })
  })

  it('disconnect purges every synced row', async () => {
    const [row] = await db
      .select()
      .from(connectorsInstallations)
      .where(eq(connectorsInstallations.tenantId, tenantId))
    const res = await request(`${BASE}/installations/${row?.id}`, {
      method: 'DELETE',
      headers: ownerCookie,
    })
    expect(res.status).toBe(204)
    for (const table of [
      connectorsConnections,
      connectorsSyncCursors,
      connectorsDirectoryUsers,
      connectorsDirectoryGroups,
      connectorsGroupMembers,
      connectorsCalendarEvents,
    ]) {
      expect(await db.select().from(table).where(eq(table.tenantId, tenantId))).toEqual([])
    }
  })
})
