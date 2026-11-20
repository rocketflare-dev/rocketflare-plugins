/**
 * drizzle-cube's MCP tools offered through the app's own `/mcp` (`../../tools/cube-tools.ts`):
 * listed as read-only `analytics_*` tools, answering exactly what `/cubejs-api` answers for the
 * same reader, and never another organisation's rows or an admin-only cube's to a member.
 */
import {
  callMcpTool,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
} from '@testkit/integration'
import { beforeAll, describe, expect, it } from 'vitest'
import { activityEvents } from '@/db/schema/kit'
import type { ToolCtx } from '@/plugins/api'
import { buildSecurityContext } from '../../cubes/security'
import { analyticsCubeTools, toolSecurityContext } from '../../tools/cube-tools'

const db = setupTestDatabase()
const ORIGIN = { Origin: 'http://localhost:3001' }
const TOOLS = ['analytics_discover', 'analytics_validate', 'analytics_load']
const EVENTS_QUERY = {
  measures: ['ActivityEvents.count'],
  dimensions: ['ActivityEvents.type'],
}
const MEMBERS_QUERY = { measures: ['TenantUsers.count'], dimensions: ['TenantUsers.role'] }

type Rows = Record<string, unknown>[]

interface Org {
  tenantId: string
  ownerId: string
  memberId: string
  ownerCookie: Record<string, string>
  memberCookie: Record<string, string>
}

async function seedOrg(marker: string, extraMembers: number): Promise<Org> {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenant.id, 'member')
  for (let i = 0; i < extraMembers; i++) {
    const m = await createTestUser(db)
    await linkUserToTenant(db, m.id, tenant.id, 'member')
  }
  await db.insert(activityEvents).values({
    tenantId: tenant.id,
    userId: user.id,
    type: marker,
    subjectType: 'Test',
    subjectId: 'x',
  })
  return {
    tenantId: tenant.id,
    ownerId: user.id,
    memberId: member.id,
    ownerCookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    memberCookie: sessionCookieHeader(await createTestSession(db, member.id, tenant.id)),
  }
}

/** `/cubejs-api/v1/load` for the same reader — what an MCP answer must equal. */
async function httpLoad(cookie: Record<string, string>, query: unknown): Promise<Rows> {
  const res = await request(
    '/cubejs-api/v1/load',
    { method: 'POST', headers: { ...cookie, ...ORIGIN } },
    { json: { query } }
  )
  expect(res.status, await res.clone().text()).toBe(200)
  const body = await json<{ results: { data: Rows }[] }>(res)
  return body.results[0]?.data ?? []
}

/** `analytics_load` over the real `/mcp`, as `as` in `tenant`; its rows. */
async function mcpLoad(as: string, tenant: string, query: unknown): Promise<Rows> {
  const result = await callMcpTool(db, 'analytics_load', { as, tenant, args: { query } })
  expect(result.listed).toBe(true)
  expect(result.isError, result.text ?? '').toBe(false)
  return rowsOf(result.json)
}

/** drizzle-cube's `load` answers `{ data: [...] , … }`. */
function rowsOf(answer: unknown): Rows {
  const data = (answer as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error(`unexpected load answer: ${JSON.stringify(answer)}`)
  return data as Rows
}

const sortRows = (rows: Rows) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

let a: Org
let b: Org

beforeAll(async () => {
  a = await seedOrg('analytics.marker-a', 2)
  b = await seedOrg('analytics.marker-b', 0)
})

describe('the cube tools over MCP', () => {
  it('are listed as read-only analytics_* tools under the default exposure', async () => {
    for (const name of TOOLS) {
      const result = await callMcpTool(db, name, {
        as: a.memberId,
        tenant: a.tenantId,
        scopes: ['mcp:read'],
        exposure: 'read_only',
      })
      expect(result.listed, name).toBe(true)
      expect(result.listing?.title, name).toBeTruthy()
      expect(result.listing?.annotations, name).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      })
      expect(result.listing?.description ?? '', name).not.toMatch(/rocketflare/i)
    }
  })

  it('discover names the cubes, in our tool names', async () => {
    const result = await callMcpTool(db, 'analytics_discover', {
      as: a.memberId,
      tenant: a.tenantId,
      args: { topic: 'members' },
    })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('TenantUsers')
    const load = await callMcpTool(db, 'analytics_load', { as: a.memberId, tenant: a.tenantId })
    expect(load.listing?.description).toContain("You MUST have called 'analytics_discover' first")
    expect(load.listing?.description).not.toContain('"chart"')
  })

  it('validate answers for a good query and corrects a bad one', async () => {
    const good = await callMcpTool(db, 'analytics_validate', {
      as: a.memberId,
      tenant: a.tenantId,
      args: { query: MEMBERS_QUERY },
    })
    expect(good.isError).toBe(false)
    const bad = await callMcpTool(db, 'analytics_validate', {
      as: a.memberId,
      tenant: a.tenantId,
      args: { query: { measures: ['TenantUsers.nope'] } },
    })
    expect(bad.text ?? '').toMatch(/nope/)
  })

  it('load answers exactly what /cubejs-api answers for the same reader', async () => {
    for (const [as, cookie] of [
      [a.ownerId, a.ownerCookie],
      [a.memberId, a.memberCookie],
    ] as const) {
      for (const query of [MEMBERS_QUERY, EVENTS_QUERY]) {
        expect(sortRows(await mcpLoad(as, a.tenantId, query))).toEqual(
          sortRows(await httpLoad(cookie, query))
        )
      }
    }
  })

  it('never answers another organisation’s rows', async () => {
    const events = await mcpLoad(b.ownerId, b.tenantId, EVENTS_QUERY)
    const types = events.map(r => r['ActivityEvents.type'])
    expect(types).toContain('analytics.marker-b')
    expect(types).not.toContain('analytics.marker-a')
    // A has four members, B two — each organisation counts only its own.
    const total = (rows: Rows) => rows.reduce((n, r) => n + Number(r['TenantUsers.count']), 0)
    expect(total(await mcpLoad(a.ownerId, a.tenantId, MEMBERS_QUERY))).toBe(4)
    expect(total(await mcpLoad(b.ownerId, b.tenantId, MEMBERS_QUERY))).toBe(2)
  })

  it('keeps the admin-only ActivityEvents cube from a member, through every tool', async () => {
    expect(await mcpLoad(a.ownerId, a.tenantId, EVENTS_QUERY)).not.toEqual([])
    expect(await mcpLoad(a.memberId, a.tenantId, EVENTS_QUERY)).toEqual([])
    for (const name of TOOLS) {
      const result = await callMcpTool(db, name, {
        as: a.memberId,
        tenant: a.tenantId,
        args: name === 'analytics_discover' ? { topic: 'activity' } : { query: EVENTS_QUERY },
      })
      expect(result.text ?? '', name).not.toContain('analytics.marker-a')
    }
  })

  it('turns a query the library refuses into a dead end with a hint, not a failure', async () => {
    const result = await callMcpTool(db, 'analytics_load', {
      as: a.memberId,
      tenant: a.tenantId,
      args: { query: { measures: ['Nope.count'] } },
    })
    expect(result.isError).toBe(false)
    expect(result.json).toMatchObject({
      error: expect.any(String),
      hint: expect.stringContaining('analytics_discover'),
    })
  })

  it('is offered to MCP clients and agent runs, never the chat panel', async () => {
    const tools = await analyticsCubeTools(toolCtxFor({ userId: a.memberId, can: true }))
    expect(tools.map(t => t.name).sort()).toEqual([...TOOLS].sort())
    for (const tool of tools) expect(tool.surfaces).toEqual(['mcp', 'agents'])
  })

  it('offers nothing to a run with no person behind it, or to a reader without the grant', async () => {
    expect(await analyticsCubeTools(toolCtxFor({ userId: null, can: true }))).toEqual([])
    expect(await analyticsCubeTools(toolCtxFor({ userId: a.memberId, can: false }))).toEqual([])
  })
})

describe('the security context a cube tool compiles under', () => {
  it('is the one /cubejs-api builds: role, groups by type for a member, none for an admin', () => {
    const finance = { id: 'g-finance', name: 'Finance', typeName: 'Department' }
    const asReader = (userId: string, role: 'member' | 'owner', isAdmin: boolean) =>
      toolSecurityContext({
        tenantId: a.tenantId,
        requester: { userId, role, isAdmin, groups: [finance] },
      })
    const member = asReader(a.memberId, 'member', false)
    expect(member).toEqual({
      tenantId: a.tenantId,
      userId: a.memberId,
      role: 'member',
      groupIds: ['g-finance'],
      groups: { Department: ['Finance'] },
      groupIdsByType: { Department: ['g-finance'] },
      isAdmin: false,
    })
    // The same reader through the route's builder gives the same context.
    expect(
      buildSecurityContext({
        tenantId: a.tenantId,
        userId: a.memberId,
        role: 'member',
        isAdmin: false,
        groups: [finance],
      } as unknown as Parameters<typeof buildSecurityContext>[0])
    ).toEqual(member)
    expect(asReader(a.ownerId, 'owner', true)).toMatchObject({
      role: 'owner',
      isAdmin: true,
      groupIds: [],
    })
    expect(() => toolSecurityContext({ tenantId: a.tenantId, requester: null })).toThrow()
  })
})

/** The slice of `ToolCtx` the cube tools read — the run's tenant, reader, grants and features. */
function toolCtxFor(input: { userId: string | null; can: boolean }): ToolCtx {
  return {
    db,
    tenantId: a.tenantId,
    scope: { tenantId: a.tenantId, userId: input.userId, groupIds: [], bypass: false },
    requester: input.userId
      ? { userId: input.userId, role: 'member', isAdmin: false, groups: [] }
      : null,
    can: () => input.can,
    features: async () => [],
  } as unknown as ToolCtx
}
