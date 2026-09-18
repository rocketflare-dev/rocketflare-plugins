/**
 * The plugin's server behaviour, on real Postgres: the settings routes (auth, roles, the key never
 * leaving the server, the update rules, tenant isolation) and the per-tenant tool gate — a tenant
 * that has not turned web search on is offered no web tools at all.
 *
 * Outbound calls go through an injected `fetch`, so nothing here reaches a provider and no global
 * is stubbed.
 */
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
} from '@testkit/integration'
import { makeToolCtx } from '@testkit/unit'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadRow, nextSettings } from '../../api/settings'
import { webSearchSettings } from '../../db/schema'
import { webKnowledgeServer } from '../../index'
import { FETCH_PAGE_TOOL, fetchPageTool } from '../../tools/fetch-page'
import { WEB_SEARCH_TOOL, webSearchTool } from '../../tools/web-search'

const db = setupTestDatabase()
const BASE = '/api/web-knowledge/settings'

let tenantId: string
let otherTenantId: string
let ownerCookie: Record<string, string>
let memberCookie: Record<string, string>
let otherCookie: Record<string, string>

async function put(headers: Record<string, string>, body: unknown) {
  return request(BASE, { method: 'PUT', headers }, { json: body })
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id

  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))

  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenantId, 'member')
  memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenantId))

  const outsider = await createTestUser(db)
  await linkUserToTenant(db, outsider.id, otherTenantId, 'owner')
  otherCookie = sessionCookieHeader(await createTestSession(db, outsider.id, otherTenantId))
})

describe('settings routes', () => {
  it('401 without a session', async () => {
    const res = await request(BASE)
    expect(res.status).toBe(401)
  })

  it('answers the defaults for an organisation that never saved anything', async () => {
    const res = await request(BASE, { headers: memberCookie })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      enabled: false,
      provider: 'tavily',
      hasCredential: false,
      updatedAt: null,
    })
  })

  it('403 for a member writing, with the error envelope', async () => {
    const res = await put(memberCookie, { enabled: false })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, error: expect.any(String) })
  })

  it('refuses to turn search on without a key', async () => {
    const res = await put(ownerCookie, { enabled: true })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'web_search_key_required' })
  })

  it('seals the key, never echoes it, and a member can read the result', async () => {
    const res = await put(ownerCookie, {
      provider: 'brave',
      apiKey: 'brave-secret-123',
      enabled: true,
      maxResults: 3,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('brave-secret-123')
    expect(JSON.parse(text)).toMatchObject({
      enabled: true,
      provider: 'brave',
      hasCredential: true,
      maxResults: 3,
    })
    const row = await loadRow(db, tenantId)
    expect(row?.apiKeyEnc).toBeTruthy()
    expect(row?.apiKeyEnc).not.toContain('brave-secret-123')

    const read = await request(BASE, { headers: memberCookie })
    expect(await read.text()).not.toContain('brave-secret-123')
  })

  it('is invisible to another organisation, which cannot overwrite it either', async () => {
    const read = await request(BASE, { headers: otherCookie })
    expect(await json(read)).toMatchObject({ enabled: false, hasCredential: false })

    await put(otherCookie, { provider: 'exa', apiKey: 'exa-other', enabled: false })
    const mine = await loadRow(db, tenantId)
    expect(mine?.provider).toBe('brave')
    const [theirs] = await db
      .select()
      .from(webSearchSettings)
      .where(eq(webSearchSettings.tenantId, otherTenantId))
    expect(theirs?.provider).toBe('exa')
  })

  it('test with no key answers a verdict, not an error', async () => {
    const res = await request(
      `${BASE}/test`,
      { method: 'POST', headers: otherCookie },
      { json: { provider: 'serper' } }
    )
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: false, provider: 'serper', code: 'no_key' })
  })
})

describe('nextSettings (the update rules)', () => {
  const existing = {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-000000000002',
    enabled: true,
    provider: 'tavily',
    apiKeyEnc: 'sealed',
    maxResults: 5,
    updatedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('keeps the key when it is omitted', () => {
    expect(nextSettings(existing, { maxResults: 2 })).toMatchObject({
      key: { kind: 'keep' },
      hasKey: true,
      enabled: true,
      maxResults: 2,
    })
  })

  it('clears it on null, and on a provider change with no new key', () => {
    expect(nextSettings(existing, { apiKey: null }).key).toEqual({ kind: 'clear' })
    expect(nextSettings(existing, { provider: 'brave' })).toMatchObject({
      key: { kind: 'clear' },
      hasKey: false,
    })
  })

  it('turns search on with the first key, unless told not to', () => {
    const off = { ...existing, enabled: false, apiKeyEnc: null }
    expect(nextSettings(undefined, { apiKey: 'k' }).enabled).toBe(true)
    expect(nextSettings(off, { apiKey: 'k' }).enabled).toBe(true)
    expect(nextSettings(off, { apiKey: 'k', enabled: false }).enabled).toBe(false)
  })

  it('keeps a deliberate "off" when a key is replaced, on any provider', () => {
    const off = { ...existing, enabled: false }
    expect(nextSettings(off, { apiKey: 'new' }).enabled).toBe(false)
    expect(nextSettings(off, { provider: 'exa', apiKey: 'new' }).enabled).toBe(false)
  })

  it('sets a new key with a provider change', () => {
    expect(nextSettings(existing, { provider: 'exa', apiKey: 'k' })).toMatchObject({
      provider: 'exa',
      key: { kind: 'set', apiKey: 'k' },
      hasKey: true,
    })
  })
})

describe('agent tools', () => {
  async function toolsFor(tenant: string) {
    const ctx = makeToolCtx({ db, tenantId: tenant })
    // biome-ignore lint/suspicious/noExplicitAny: the runtime's context, built from the test one
    const raw = { db, cfg: ctx.config, env: ctx.env as any, scope: ctx.scope }
    return (await webKnowledgeServer.agentTools(raw)).map(t => t.name)
  }

  it('are offered to a tenant with search on and a key, and to nobody else', async () => {
    expect(await toolsFor(tenantId)).toEqual([WEB_SEARCH_TOOL, FETCH_PAGE_TOOL])
    // The other tenant saved a key and explicitly left search off.
    expect(await toolsFor(otherTenantId)).toEqual([])
  })

  it('stop being offered once search is turned off', async () => {
    await put(ownerCookie, { enabled: false })
    expect(await toolsFor(tenantId)).toEqual([])
    await put(ownerCookie, { enabled: true })
  })

  it('web_search opens the key only at call time and answers normalised hits', async () => {
    const ctx = makeToolCtx({ db, tenantId })
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('api.search.brave.com')
      expect(new Headers(init?.headers).get('x-subscription-token')).toBe('brave-secret-123')
      return Response.json({
        web: { results: [{ title: 'Workers', url: 'https://w.example.com', description: 'Edge' }] },
      })
    })
    const search = { provider: 'brave' as const, maxResults: 3, apiKeyEnc: '' }
    search.apiKeyEnc = (await loadRow(db, tenantId))?.apiKeyEnc ?? ''
    const tool = webSearchTool(ctx, search, { fetch })
    expect(fetch).not.toHaveBeenCalled()
    const out = JSON.parse(await (tool.handler as (i: unknown) => Promise<string>)({ query: 'x' }))
    expect(out.results).toEqual([
      { title: 'Workers', url: 'https://w.example.com', snippet: 'Edge' },
    ])
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('count')).toBe('3')
  })

  it('web_search turns a rejected key into a hint to tell the user', async () => {
    const ctx = makeToolCtx({ db, tenantId })
    const apiKeyEnc = (await loadRow(db, tenantId))?.apiKeyEnc ?? ''
    const tool = webSearchTool(
      ctx,
      { provider: 'brave', maxResults: 3, apiKeyEnc },
      { fetch: async () => new Response('no', { status: 401 }) }
    )
    const out = JSON.parse(await (tool.handler as (i: unknown) => Promise<string>)({ query: 'x' }))
    expect(out).toMatchObject({ error: 'web_key_rejected', hint: expect.stringContaining('admin') })
  })

  it('fetch_page refuses a private URL without making a request', async () => {
    const ctx = makeToolCtx({ db, tenantId })
    const fetch = vi.fn()
    const tool = fetchPageTool(ctx, { provider: 'brave', maxResults: 3, apiKeyEnc: 'x' }, { fetch })
    const out = JSON.parse(
      await (tool.handler as (i: unknown) => Promise<string>)({ url: 'http://localhost:5432/' })
    )
    expect(out.error).toBe('web_url_refused')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetch_page windows a long page by the caller’s budget', async () => {
    const ctx = makeToolCtx({ db, tenantId, maxDocumentChars: 10 })
    const tool = fetchPageTool(
      ctx,
      { provider: 'brave', maxResults: 3, apiKeyEnc: 'x' },
      {
        fetch: async () =>
          new Response('abcdefghijklmnopqrstuvwxyz', { headers: { 'content-type': 'text/plain' } }),
      }
    )
    const handler = tool.handler as (i: unknown) => Promise<string>
    const first = JSON.parse(await handler({ url: 'https://example.com/a' }))
    expect(first).toMatchObject({
      content: 'abcdefghij',
      hasMore: true,
      nextOffset: 10,
      totalChars: 26,
    })
    expect(first.note).toMatch(/third-party/)
    const last = JSON.parse(await handler({ url: 'https://example.com/a', offset: 20 }))
    expect(last).toMatchObject({ content: 'uvwxyz', hasMore: false })
  })
})
