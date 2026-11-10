// @vitest-isolate
// Mocks `@/plugins/api/peers` (to register third-party providers through `extensions`), so this
// file needs its own module registry.
/**
 * `GET /api/global-search` on real Postgres, through the real mount:
 *
 * - tenant isolation: two organisations' documents, members and chats, and neither ever sees the
 *   other's hit — nor the other's re-ranker settings;
 * - entities by name: people (admins only), agents, and the reader's OWN chats — never a
 *   colleague's, whatever the role;
 * - visibility: a document restricted to its owner is not a member's hit;
 * - a guarded provider is skipped (not called, not listed) for a reader without the permission;
 * - a slow provider is reported in `degraded` as `timeout` and the request still answers;
 * - a throwing provider and an invalid answer are `error` / `invalid_response`, never a 5xx;
 * - a third-party provider registered through `extensions` (no import of this plugin) shows up,
 *   and an invalid registration is refused with an error naming who contributed;
 * - a re-ranker that cannot be reached leaves the fused order and says why — no 5xx;
 * - the settings routes: admin-only, the key sealed and never echoed.
 */
import type {
  GlobalSearchResult,
  SearchProvidersResponse,
} from '@rocketflare/shared/plugins/global-search/index'
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
import { makeJobCtx } from '@testkit/unit'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestDocument, listAgents } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { InvalidSearchProviderError } from '../../services/registry'
import { loadSettingsRow } from '../../services/settings'
import type { SearchProvider } from '../../types'

/** What the mocked `extensions()` adds on top of the installed plugins' contributions. */
const extra = vi.hoisted(() => ({
  contributions: [] as unknown[],
  sources: [] as string[],
}))

vi.mock('@/plugins/api/peers', async importOriginal => {
  const real = await importOriginal<typeof import('@/plugins/api/peers')>()
  return {
    ...real,
    extensions: (key: string) => [
      ...real.extensions(key),
      ...(key === 'global-search.providers' ? extra.contributions : []),
    ],
    extensionSources: (key: string) => [
      ...real.extensionSources(key),
      ...(key === 'global-search.providers' ? extra.sources : []),
    ],
  }
})

const db = setupTestDatabase()

let tenantId: string
let otherTenantId: string
let ownerId: string
let ownerCookie: Record<string, string>
let memberCookie: Record<string, string>
let otherCookie: Record<string, string>
let memberId: string
let outsiderId: string
/** Unique per run: the users table is global and the test database is shared. */
const TAG = `q${Date.now().toString(36)}`
const MEMBER_NAME = `Zebedee Quill ${TAG}`
const OUTSIDER_NAME = `Zebedee Outsider ${TAG}`

async function search(headers: Record<string, string>, params: Record<string, string>) {
  const res = await request(`/api/global-search?${new URLSearchParams(params)}`, { headers })
  expect(res.status).toBe(200)
  return json<GlobalSearchResult>(res)
}

function acme(
  over: Partial<SearchProvider> & Pick<SearchProvider, 'id' | 'search'>
): SearchProvider {
  return {
    label: 'Acme',
    kinds: [{ kind: over.id.split(':')[1] ?? 'thing', label: 'Things', order: 30 }],
    ...over,
  }
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  otherTenantId = (await createTestTenant(db)).id

  const owner = await createTestUser(db)
  ownerId = owner.id
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))

  const member = await createTestUser(db, {
    name: MEMBER_NAME,
    email: `zebedee.${TAG}@example.test`,
  })
  memberId = member.id
  await linkUserToTenant(db, member.id, tenantId, 'member')
  memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenantId))

  const outsider = await createTestUser(db, { name: OUTSIDER_NAME })
  outsiderId = outsider.id
  await linkUserToTenant(db, outsider.id, otherTenantId, 'owner')
  otherCookie = sessionCookieHeader(await createTestSession(db, outsider.id, otherTenantId))

  const ctx = makeJobCtx({ db })
  await ingestDocument(ctx, {
    tenantId,
    userId: null,
    source: 'global-search:test',
    externalId: 'pelican-1',
    title: 'Pelican migration handbook',
    text: 'Pelicans migrate along the coast every autumn. The handbook lists every roost.',
  })
  await ingestDocument(ctx, {
    tenantId,
    userId: owner.id,
    source: 'global-search:test',
    externalId: 'pelican-private',
    title: 'Pelican budget (owner only)',
    text: 'The private pelican budget for next year.',
    visibility: 'groups',
    groupIds: [],
  })
  await ingestDocument(ctx, {
    tenantId: otherTenantId,
    userId: null,
    source: 'global-search:test',
    externalId: 'pelican-2',
    title: 'Pelican secrets of the other organisation',
    text: 'Pelicans of the other organisation nest inland.',
  })
})

beforeAll(async () => {
  const { conversations } = allTables()
  const chat = (tenant: string, userId: string, title: string) => ({
    tenantId: tenant,
    userId,
    title,
    provider: 'anthropic' as const,
    model: 'test-model',
  })
  await db
    .insert(conversations)
    .values([
      chat(tenantId, ownerId, `Heron plans ${TAG}`),
      chat(tenantId, memberId, `Heron notes of the member ${TAG}`),
      chat(otherTenantId, outsiderId, `Heron secrets elsewhere ${TAG}`),
    ])
})

beforeEach(() => {
  extra.contributions = []
  extra.sources = []
})

describe('the search route', () => {
  it('401 without a session', async () => {
    const res = await request('/api/global-search?q=pelican')
    expect(res.status).toBe(401)
  })

  it('400 without a query, with the error envelope', async () => {
    const res = await request('/api/global-search', { headers: memberCookie })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ statusCode: 400, error: expect.any(String) })
  })

  it('finds a document, deep-linked to its passage', async () => {
    const docs = await search(memberCookie, { q: 'pelican' })
    const handbook = docs.items.find(h => h.title === 'Pelican migration handbook')
    expect(handbook).toMatchObject({ kind: 'document', provider: 'global-search:documents' })
    expect(handbook?.href).toMatch(/^\/documents\/[0-9a-f-]+\?offset=\d+&q=pelican$/)
    expect(docs.semantic).toBe('used')
    expect(docs.degraded).toEqual([])
  })

  it('narrows to the kinds asked for', async () => {
    const out = await search(ownerCookie, { q: 'zebedee', kinds: 'person' })
    expect(out.items.length).toBeGreaterThan(0)
    expect(out.items.every(h => h.kind === 'person')).toBe(true)
    expect(out.semantic).toBe('skipped')
  })
})

describe('entities by name', () => {
  it('finds a member by name and by email, linked to Settings → People', async () => {
    const byName = await search(ownerCookie, { q: `quill ${TAG}`, kinds: 'person' })
    expect(byName.items).toEqual([
      expect.objectContaining({
        kind: 'person',
        title: MEMBER_NAME,
        ref: memberId,
        href: `/settings?tab=people&member=${memberId}`,
        provider: 'global-search:people',
      }),
    ])
    const byEmail = await search(ownerCookie, { q: `zebedee.${TAG}@`, kinds: 'person' })
    expect(byEmail.items.map(h => h.ref)).toEqual([memberId])
  })

  it('treats % and _ in the query as text, not wildcards', async () => {
    const out = await search(ownerCookie, { q: '%', kinds: 'person' })
    expect(out.items).toEqual([])
    // `_` matches only a literal underscore (the generated test emails have one; Zebedee's has not).
    const underscore = await search(ownerCookie, { q: '_', kinds: 'person' })
    for (const hit of underscore.items) expect(`${hit.title} ${hit.snippet}`).toContain('_')
    expect(underscore.items.map(h => h.ref)).not.toContain(memberId)
  })

  it('offers people only to someone who may manage members', async () => {
    const member = await search(memberCookie, { q: 'zebedee' })
    expect(member.items.some(h => h.kind === 'person')).toBe(false)
    const meta = await json<SearchProvidersResponse>(
      await request('/api/global-search/providers', { headers: memberCookie })
    )
    expect(meta.providers.map(p => p.id)).not.toContain('global-search:people')
  })

  it('finds a registered agent by its title, linked to its runs', async () => {
    const [agent] = await listAgents()
    if (!agent) throw new Error('no agent registered')
    const out = await search(memberCookie, { q: agent.title, kinds: 'agent' })
    expect(out.items[0]).toMatchObject({
      kind: 'agent',
      title: agent.title,
      href: `/agents?agentKey=${encodeURIComponent(agent.key)}`,
      provider: 'global-search:agents',
    })
  })

  it("finds the reader's own chats and never a colleague's, owner or not", async () => {
    const owner = await search(ownerCookie, { q: `heron`, kinds: 'chat' })
    expect(owner.items.map(h => h.title)).toEqual([`Heron plans ${TAG}`])
    expect(owner.items[0]?.href).toMatch(/^\/chat\/[0-9a-f-]+$/)
    const member = await search(memberCookie, { q: `heron`, kinds: 'chat' })
    expect(member.items.map(h => h.title)).toEqual([`Heron notes of the member ${TAG}`])
  })
})

describe('tenant isolation', () => {
  it("never shows one organisation's documents to another, either way round", async () => {
    const mine = await search(ownerCookie, { q: 'pelican', kinds: 'document' })
    const theirs = await search(otherCookie, { q: 'pelican', kinds: 'document' })
    expect(mine.items.map(h => h.title)).not.toContain('Pelican secrets of the other organisation')
    expect(theirs.items.map(h => h.title)).toEqual(['Pelican secrets of the other organisation'])
    const myRefs = new Set(mine.items.map(h => h.ref))
    for (const hit of theirs.items) expect(myRefs.has(hit.ref)).toBe(false)
  })

  it("never shows one organisation's members or chats to another", async () => {
    const mine = await search(ownerCookie, { q: 'zebedee' })
    expect(mine.items.map(h => h.title)).toContain(MEMBER_NAME)
    expect(mine.items.map(h => h.title)).not.toContain(OUTSIDER_NAME)
    const theirs = await search(otherCookie, { q: 'zebedee' })
    expect(theirs.items.filter(h => h.kind === 'person').map(h => h.title)).toEqual([OUTSIDER_NAME])
    const theirChats = await search(otherCookie, { q: 'heron', kinds: 'chat' })
    expect(theirChats.items.map(h => h.title)).toEqual([`Heron secrets elsewhere ${TAG}`])
    const myChats = await search(ownerCookie, { q: 'heron secrets', kinds: 'chat' })
    expect(myChats.items).toEqual([])
  })

  it('keeps a document restricted to its owner out of a member’s results', async () => {
    const owner = await search(ownerCookie, { q: 'pelican budget', kinds: 'document' })
    const member = await search(memberCookie, { q: 'pelican budget', kinds: 'document' })
    expect(owner.items.map(h => h.title)).toContain('Pelican budget (owner only)')
    expect(member.items.map(h => h.title)).not.toContain('Pelican budget (owner only)')
  })

  it("never reads or overwrites another organisation's re-ranker settings", async () => {
    const put = await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: ownerCookie },
      {
        json: {
          rerankBaseUrl: 'https://api.cohere.com/v2',
          rerankModel: 'rerank-v3.5',
          rerankApiKey: 'cohere-secret-123',
          rerankEnabled: false,
        },
      }
    )
    expect(put.status).toBe(200)
    const read = await request('/api/global-search/settings', { headers: otherCookie })
    expect(await json(read)).toMatchObject({ hasCredential: false, rerankBaseUrl: null })
    await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: otherCookie },
      { json: { rerankModel: 'theirs' } }
    )
    expect((await loadSettingsRow(db, tenantId))?.rerankModel).toBe('rerank-v3.5')
    expect((await loadSettingsRow(db, otherTenantId))?.rerankModel).toBe('theirs')
  })
})

describe('providers registered through extensions', () => {
  it('shows a third-party provider’s hits and kinds, fused with the built-ins', async () => {
    const seen: { tenantId: string; userId: string }[] = []
    extra.sources = ['acme']
    extra.contributions = [
      acme({
        id: 'acme:tickets',
        kinds: [{ kind: 'ticket', label: 'Tickets', badge: 'ticket', tone: 'warning', order: 20 }],
        async search(ctx, input) {
          seen.push({ tenantId: ctx.tenantId, userId: ctx.userId })
          expect([...input.kinds]).toEqual(['ticket'])
          return [
            {
              kind: 'ticket',
              title: 'Pelican feeder broken',
              snippet: null,
              ref: 'T-1',
              href: '/acme/T-1',
            },
          ]
        },
      }),
    ]
    const out = await search(ownerCookie, { q: 'pelican' })
    expect(out.items).toContainEqual(
      expect.objectContaining({ kind: 'ticket', provider: 'acme:tickets', href: '/acme/T-1' })
    )
    expect(seen).toEqual([{ tenantId, userId: ownerId }])
    const meta = await json<SearchProvidersResponse>(
      await request('/api/global-search/providers', { headers: ownerCookie })
    )
    expect(meta.providers.map(p => p.id)).toEqual([
      'global-search:people',
      'global-search:agents',
      'global-search:chats',
      'global-search:documents',
      'acme:tickets',
    ])
    expect(meta.providers.at(-1)?.kinds[0]).toMatchObject({ kind: 'ticket', tone: 'warning' })
  })

  it('skips a guarded provider for a reader without the permission — not called, not listed', async () => {
    const calls: string[] = []
    extra.sources = ['acme']
    extra.contributions = [
      acme({
        id: 'acme:traces',
        guard: { action: 'read', subject: 'Trace' },
        async search(ctx) {
          calls.push(ctx.userId)
          return [
            { kind: 'traces', title: 'Pelican trace', snippet: null, ref: 'x', href: '/acme/x' },
          ]
        },
      }),
    ]
    const member = await search(memberCookie, { q: 'pelican' })
    expect(member.items.map(h => h.provider)).not.toContain('acme:traces')
    const memberMeta = await json<SearchProvidersResponse>(
      await request('/api/global-search/providers', { headers: memberCookie })
    )
    expect(memberMeta.providers.map(p => p.id)).not.toContain('acme:traces')
    expect(calls).toEqual([])

    const owner = await search(ownerCookie, { q: 'pelican' })
    expect(owner.items.map(h => h.provider)).toContain('acme:traces')
    expect(calls).toEqual([ownerId])
  })

  it('reports a slow provider as a timeout and answers anyway', async () => {
    extra.sources = ['acme']
    extra.contributions = [
      acme({
        id: 'acme:slow',
        // Never settles, and ignores the signal: the budget must not wait for it.
        search: () => new Promise(() => {}),
      }),
      acme({
        id: 'acme:broken',
        async search() {
          throw new Error('upstream exploded')
        },
      }),
      acme({
        id: 'acme:liar',
        async search() {
          return [
            {
              kind: 'liar',
              title: 'Off-site',
              snippet: null,
              ref: 'x',
              href: 'https://evil.example',
            },
          ]
        },
      }),
    ]
    const started = Date.now()
    const out = await search(memberCookie, { q: 'pelican' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(out.degraded).toEqual([
      { provider: 'acme:slow', reason: 'timeout' },
      { provider: 'acme:broken', reason: 'error' },
      { provider: 'acme:liar', reason: 'invalid_response' },
    ])
    expect(out.items.map(h => h.title)).toContain('Pelican migration handbook')
  })

  it('refuses an invalid registration with an error naming who contributed', async () => {
    extra.sources = ['acme']
    extra.contributions = [{ id: 'acme:bad', label: 'Bad', kinds: [] }]
    const { installedProviders } = await import('../../services/registry')
    expect(() => installedProviders()).toThrow(InvalidSearchProviderError)
    expect(() => installedProviders()).toThrow(
      /contributed by global-search, acme.*'acme:bad'.*kinds/
    )
    const res = await request('/api/global-search?q=pelican', { headers: memberCookie })
    expect(res.status).toBe(500)
  })

  it('refuses a provider registered in another plugin’s name', async () => {
    extra.sources = ['acme']
    extra.contributions = [acme({ id: 'guide:pages', search: async () => [] })]
    const { installedProviders } = await import('../../services/registry')
    expect(() => installedProviders()).toThrow(/'guide:pages' is namespaced 'guide'/)
  })
})

describe('re-ranking', () => {
  it('a re-ranker that cannot be reached keeps the fused order and answers 200', async () => {
    const put = await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: ownerCookie },
      {
        json: {
          // Nothing listens on port 1: the call fails fast.
          rerankBaseUrl: 'https://127.0.0.1:1',
          rerankModel: 'rerank-v3.5',
          rerankApiKey: 'unreachable-key',
          rerankEnabled: true,
        },
      }
    )
    expect(put.status).toBe(200)
    const out = await search(ownerCookie, { q: 'pelican' })
    expect(out.items.length).toBeGreaterThanOrEqual(2)
    expect(out.ranking.rerank).toMatchObject({
      applied: false,
      reason: 'error',
      model: 'rerank-v3.5',
    })
    // Off again, so later searches are not slowed by it.
    await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: ownerCookie },
      { json: { rerankEnabled: false } }
    )
  })

  it('without a re-ranker the ranking says not_configured', async () => {
    const out = await search(otherCookie, { q: 'pelican' })
    expect(out.ranking).toMatchObject({ method: 'rrf', k: 60, rerank: { applied: false } })
  })
})

describe('settings routes', () => {
  it('403 for a member, read or write', async () => {
    expect((await request('/api/global-search/settings', { headers: memberCookie })).status).toBe(
      403
    )
    const res = await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: memberCookie },
      { json: { rerankEnabled: false } }
    )
    expect(res.status).toBe(403)
  })

  it('refuses to turn re-ranking on without a complete configuration', async () => {
    const res = await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: otherCookie },
      { json: { rerankEnabled: true, rerankModel: null } }
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'global_search_rerank_incomplete' })
  })

  it('refuses a non-https URL', async () => {
    const res = await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: ownerCookie },
      { json: { rerankBaseUrl: 'http://api.cohere.com/v2' } }
    )
    expect(res.status).toBe(400)
  })

  it('seals the key and never echoes it', async () => {
    const res = await request(
      '/api/global-search/settings',
      { method: 'PUT', headers: ownerCookie },
      { json: { rerankApiKey: 'sealed-secret-456' } }
    )
    const text = await res.text()
    expect(text).not.toContain('sealed-secret-456')
    expect(JSON.parse(text)).toMatchObject({ hasCredential: true })
    const row = await loadSettingsRow(db, tenantId)
    expect(row?.rerankApiKeyEnc).toBeTruthy()
    expect(row?.rerankApiKeyEnc).not.toContain('sealed-secret-456')
    const read = await request('/api/global-search/settings', { headers: ownerCookie })
    expect(await read.text()).not.toContain('sealed-secret-456')
  })

  it('the test route answers a verdict, not an error, when nothing is configured', async () => {
    const res = await request(
      '/api/global-search/settings/test',
      { method: 'POST', headers: otherCookie },
      { json: {} }
    )
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: false, code: 'incomplete' })
  })
})
