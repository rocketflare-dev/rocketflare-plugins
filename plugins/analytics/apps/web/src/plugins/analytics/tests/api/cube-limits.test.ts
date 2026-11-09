/**
 * What the cube API lets one reader do: the activity cube is for admin-level readers on every
 * query surface, a batch has a length limit, and every request runs under a statement timeout.
 */
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
} from '@testkit/integration'
import { sql } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { activityEvents } from '@/db/schema/kit'
import { pgErrorCode, rows } from '@/plugins/api'
import * as limits from '../../services/cube-limits'

const db = setupTestDatabase()
const ORIGIN = { Origin: 'http://localhost:3001' }
const EVENTS_QUERY = {
  measures: ['ActivityEvents.count'],
  dimensions: ['ActivityEvents.type'],
}

let ownerCookie: Record<string, string>
let memberCookie: Record<string, string>

beforeAll(async () => {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenant.id, 'member')
  ownerCookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenant.id))
  await db.insert(activityEvents).values({
    tenantId: tenant.id,
    userId: user.id,
    type: 'limits.marker',
    subjectType: 'Test',
    subjectId: 'x',
  })
})

afterEach(() => vi.restoreAllMocks())

const callMcpLoad = (cookie: Record<string, string>) =>
  request(
    '/mcp',
    {
      method: 'POST',
      headers: { ...cookie, Accept: 'application/json, text/event-stream' },
    },
    {
      json: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'load', arguments: { query: EVENTS_QUERY } },
      },
    }
  )

const post = (path: string, cookie: Record<string, string>, body: unknown) =>
  request(path, { method: 'POST', headers: { ...cookie, ...ORIGIN } }, { json: body })

interface LoadBody {
  results: { data: Record<string, unknown>[] }[]
}

describe('the ActivityEvents cube', () => {
  it('answers an admin-level reader', async () => {
    const res = await post('/cubejs-api/v1/load', ownerCookie, { query: EVENTS_QUERY })
    const body = await json<LoadBody>(res)
    expect(body.results[0]?.data.map(r => r['ActivityEvents.type'])).toContain('limits.marker')
    expect(await (await callMcpLoad(ownerCookie)).text()).toContain('limits.marker')
  })

  it('has no rows for a member on /load', async () => {
    const res = await post('/cubejs-api/v1/load', memberCookie, { query: EVENTS_QUERY })
    expect(res.status).toBe(200)
    expect((await json<LoadBody>(res)).results[0]?.data).toEqual([])
  })

  it('has no rows for a member on /batch', async () => {
    const res = await post('/cubejs-api/v1/batch', memberCookie, { queries: [EVENTS_QUERY] })
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('limits.marker')
  })

  it('has no rows for a member on /mcp', async () => {
    const res = await callMcpLoad(memberCookie)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('limits.marker')
  })
})

describe('the batch limit', () => {
  const queries = (n: number) => Array.from({ length: n }, () => ({ measures: ['Users.count'] }))

  it('refuses a longer batch before running any of it', async () => {
    const run = vi.spyOn(limits, 'withStatementTimeout')
    const res = await post('/cubejs-api/v1/batch', ownerCookie, {
      queries: queries(limits.CUBE_BATCH_MAX + 1),
    })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'cube_batch_too_large', statusCode: 400 })
    expect(run).not.toHaveBeenCalled()
  })

  it('runs a batch of exactly the limit', async () => {
    const res = await post('/cubejs-api/v1/batch', ownerCookie, {
      queries: queries(limits.CUBE_BATCH_MAX),
    })
    expect(res.status).toBe(200)
    expect((await json<{ results: unknown[] }>(res)).results).toHaveLength(limits.CUBE_BATCH_MAX)
  })
})

describe('the statement timeout', () => {
  it('cancels a statement that runs past it', async () => {
    const err = await limits
      .withStatementTimeout(db, 50, tx => tx.execute(sql`select pg_sleep(2)`))
      .catch(e => e)
    expect(pgErrorCode(err)).toBe('57014')
  })

  it('applies to that transaction only', async () => {
    const inside = await limits.withStatementTimeout(db, 1234, async tx =>
      rows<{ statement_timeout: string }>(await tx.execute(sql`show statement_timeout`))
    )
    expect(inside[0]?.statement_timeout).toBe('1234ms')
    const after = rows<{ statement_timeout: string }>(await db.execute(sql`show statement_timeout`))
    expect(after[0]?.statement_timeout).not.toBe('1234ms')
  })

  it('wraps a cube request', async () => {
    const run = vi.spyOn(limits, 'withStatementTimeout')
    const res = await post('/cubejs-api/v1/load', ownerCookie, {
      query: { measures: ['Users.count'] },
    })
    expect(res.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toBe(limits.CUBE_STATEMENT_TIMEOUT_MS)
  })
})
