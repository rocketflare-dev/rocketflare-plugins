// @vitest-isolate
// Replaces the host's generated guide with a fixture, and writes the guide's PLATFORM rows (one
// global set, `guide:*`), so it needs its own module registry and must not race another file.
/**
 * `/api/guide` and the guide's search index, end to end on real Postgres through the real app:
 *
 * - every route refuses an unauthenticated caller; an admin page is a 404 for a member;
 * - `guide.sync` writes one platform document per section, is idempotent and prunes; it fails
 *   loudly without embeddings; the cron task and the lazy check only ever ENQUEUE;
 * - two organisations both read the guide through the routes, and no route writes it;
 * - search finds a dense paraphrase that shares no keyword with the page;
 * - "Ask the Guide" streams AG-UI and ends with a resolved `guide.answer` citation.
 */
import {
  GUIDE_ANSWER_EVENT,
  GUIDE_META_SOURCE,
  GUIDE_SOURCES,
  type GuideAnswer,
  type GuideBundle,
  type GuidePageResponse,
  type GuideSearchResponse,
  type GuideTocResponse,
} from '@rocketflare/shared/plugins/guide/index'
import {
  aguiFrames,
  aguiTypes,
  createExecutionContext,
  createTestEnv,
  createTestSession,
  createTestTenantWithUser,
  customEvents,
  dispatchScheduled,
  json,
  request,
  scriptPlatformChat,
  sessionCookieHeader,
  setupTestDatabase,
  stubs,
  type TestEnv,
} from '@testkit/integration'
import { makeJobCtx } from '@testkit/unit'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformEmbeddingsError, prunePlatformDocuments } from '@/plugins/api'
import { GUIDE_CRON, resetGuideIndexMemo, syncGuide } from '../../services/sync'
import { buildFixture, FIXTURE_FILES } from '../fixture'

vi.mock('@/host/guide/content.generated', async () => {
  const { buildFixture: build } = await import('../fixture')
  return { GUIDE_BUNDLE: build() }
})

const db = setupTestDatabase()
const bundle = buildFixture()

async function as(role: 'owner' | 'admin' | 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    tenant,
    headers: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

const get = (path: string, headers: Record<string, string>, env: TestEnv = createTestEnv()) =>
  request(`/api/guide${path}`, { headers }, { env })

/** Every guide platform row gone, so each test starts from an empty index. */
async function clearIndex() {
  const ctx = makeJobCtx({ db })
  for (const source of [GUIDE_SOURCES.member, GUIDE_SOURCES.admin, GUIDE_META_SOURCE]) {
    await prunePlatformDocuments(ctx, { source, keepExternalIds: [] })
  }
}

const guideJobs = (env: TestEnv) =>
  (stubs(env).queue?.messages ?? []).filter(
    m => (m.body as { type?: string } | undefined)?.type === 'guide.sync'
  )

/** A unit vector along axis `i` (1024-dim, Workers AI's bge-m3 width). */
function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[i] = 1
  return v
}

beforeEach(async () => {
  resetGuideIndexMemo()
  await clearIndex()
})

// Platform rows are global: leaving the fixture's behind would put guide passages into every
// other file's `search_knowledge` results (the kit's chat tests assert exact frame sequences).
afterAll(clearIndex)

describe('access', () => {
  it('every route refuses an unauthenticated caller', async () => {
    for (const [method, path] of [
      ['GET', '/toc'],
      ['GET', '/page?path=start/welcome.md'],
      ['GET', '/search?q=reports'],
      ['POST', '/ask'],
    ] as const) {
      const res = await request(
        `/api/guide${path}`,
        { method, headers: { 'X-Requested-With': 'fetch' } },
        method === 'POST' ? { json: { question: 'How?' } } : {}
      )
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('a member sees only member pages; an admin page is the same 404 as a missing one', async () => {
    const member = await as('member')
    const toc = await json<GuideTocResponse>(await get('/toc', member.headers))
    expect(toc.label).toBe('Acme handbook')
    expect(toc.entries.map(e => e.path)).toEqual(['start/welcome.md', 'start/reports.md'])
    expect(toc.index).toBeNull()

    const hidden = await get('/page?path=admin/people.md', member.headers)
    expect(hidden.status).toBe(404)
    const missing = await get('/page?path=start/none.md', member.headers)
    expect(missing.status).toBe(404)
    expect(await hidden.json()).toEqual(await missing.json())
  })

  it('an admin reads the admin page, facts resolved, with the callout labels', async () => {
    const admin = await as('admin')
    const toc = await json<GuideTocResponse>(await get('/toc', admin.headers))
    expect(toc.entries.map(e => e.path)).toContain('admin/people.md')
    const page = await json<GuidePageResponse>(
      await get('/page?path=admin/people.md', admin.headers)
    )
    expect(page).toMatchObject({
      path: 'admin/people.md',
      title: 'Managing people',
      calloutLabels: ['NOTE'],
    })
    expect(page.markdown).toContain('expires after 7 days')
    expect(page.outline.map(o => o.id)).toEqual(['do-it'])
  })

  it('no route writes the guide: other methods are 404 and the index is untouched', async () => {
    await syncGuide(makeJobCtx({ db }), bundle)
    const owner = await as('owner')
    const before = await json<GuideSearchResponse>(await get('/search?q=throughput', owner.headers))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/page?path=start/reports.md', '/toc', '/search?q=x']) {
        const res = await request(
          `/api/guide${path}`,
          { method, headers: { ...owner.headers, 'X-Requested-With': 'fetch' } },
          { json: { markdown: 'hacked' } }
        )
        expect([404, 405], `${method} ${path}`).toContain(res.status)
      }
    }
    const after = await json<GuideSearchResponse>(await get('/search?q=throughput', owner.headers))
    expect(after).toEqual(before)
  })
})

describe('the index (guide.sync)', () => {
  it('one platform document per section; idempotent; prunes what the bundle dropped', async () => {
    const ctx = makeJobCtx({ db })
    const sections = bundle.pages.reduce((n, p) => n + p.sections.length, 0)
    expect(await syncGuide(ctx, bundle)).toEqual({
      created: sections,
      updated: 0,
      unchanged: 0,
      pruned: 0,
    })
    expect(await syncGuide(ctx, bundle)).toEqual({
      created: 0,
      updated: 0,
      unchanged: sections,
      pruned: 0,
    })

    const smaller: GuideBundle = buildFixture(
      FIXTURE_FILES.map(f =>
        f.path === 'start/welcome.md'
          ? { ...f, raw: f.raw.replace(/\n## Watch out for[\s\S]*$/, '\n') }
          : f
      )
    )
    const third = await syncGuide(ctx, smaller)
    expect(third.pruned).toBe(1)
    expect(third.created).toBe(0)
  })

  it('two organisations both find the guide through the routes', async () => {
    await syncGuide(makeJobCtx({ db }), bundle)
    for (const who of [await as('owner'), await as('member')]) {
      const res = await json<GuideSearchResponse>(await get('/search?q=throughput', who.headers))
      expect(res.hits[0]).toMatchObject({
        path: 'start/reports.md',
        heading: 'reading-a-report',
        href: '/guide?path=start%2Freports.md#reading-a-report',
      })
    }
  })

  it('search never shows a member an admin section', async () => {
    await syncGuide(makeJobCtx({ db }), bundle)
    const member = await as('member')
    const admin = await as('admin')
    const forMember = await json<GuideSearchResponse>(
      await get('/search?q=invitation', member.headers)
    )
    expect(forMember.hits.map(h => h.path)).not.toContain('admin/people.md')
    const forAdmin = await json<GuideSearchResponse>(
      await get('/search?q=invitation', admin.headers)
    )
    expect(forAdmin.hits[0]?.path).toBe('admin/people.md')
  })

  it('finds a dense paraphrase that shares no keyword with the page', async () => {
    const env = createTestEnv()
    const ai = stubs(env).ai
    if (!ai) throw new Error('no AI stub')
    // A vector space the test controls: anything about inviting people is axis 5, the rest 700.
    ai.respond = (_model, inputs) => {
      const texts = (Array.isArray(inputs.text) ? inputs.text : [inputs.text]).map(String)
      return {
        shape: [texts.length, 1024],
        data: texts.map(t => axis(/invitation|coworker/i.test(t) ? 5 : 700)),
      }
    }
    await syncGuide(makeJobCtx({ db, env }), bundle)
    const admin = await as('admin')
    const res = await json<GuideSearchResponse>(
      await get('/search?q=bring%20a%20coworker%20aboard', admin.headers, env)
    )
    expect(res.semantic).toBe('used')
    expect(res.hits[0]).toMatchObject({ path: 'admin/people.md', heading: 'do-it', dense: true })
    // No shared word: the same query finds nothing by keyword alone.
    const lexical = await json<GuideSearchResponse>(
      await get(
        '/search?q=bring%20a%20coworker%20aboard',
        admin.headers,
        createTestEnv({ AI: undefined })
      )
    )
    expect(lexical).toEqual({ semantic: 'unavailable', hits: [] })
  })

  it('fails loudly without a platform embedder, and admins are told', async () => {
    const env = createTestEnv({ AI: undefined })
    await expect(syncGuide(makeJobCtx({ db, env }), bundle)).rejects.toBeInstanceOf(
      PlatformEmbeddingsError
    )
    const admin = await as('admin')
    const toc = await json<GuideTocResponse>(await get('/toc', admin.headers, env))
    expect(toc.index).toBe('no_embeddings')
    expect(guideJobs(env)).toEqual([])
  })

  it('the lazy check enqueues once while the index is stale, and is ready once synced', async () => {
    const env = createTestEnv()
    const admin = await as('admin')
    expect((await json<GuideTocResponse>(await get('/toc', admin.headers, env))).index).toBe(
      'building'
    )
    await get('/toc', admin.headers, env)
    await get('/search?q=x', admin.headers, env)
    expect(guideJobs(env)).toHaveLength(1)
    expect(guideJobs(env)[0]?.body).toMatchObject({ payload: { reason: 'lazy' } })

    // The job lands: the very next request sees it — no waiting out the retry window.
    await syncGuide(makeJobCtx({ db, env }), buildFixture())
    expect((await json<GuideTocResponse>(await get('/toc', admin.headers, env))).index).toBe(
      'ready'
    )
    expect(guideJobs(env)).toHaveLength(1)
  })

  it('the cron task enqueues guide.sync and never syncs inline', async () => {
    const env = createTestEnv()
    const reports = await dispatchScheduled(GUIDE_CRON, env, createExecutionContext())
    expect(reports.find(r => r.task === 'guide.sync')).toMatchObject({ status: 'ok' })
    expect(guideJobs(env).map(m => (m.body as { payload: unknown }).payload)).toEqual([
      { reason: 'cron' },
    ])
    const owner = await as('owner')
    const res = await json<GuideSearchResponse>(
      await get('/search?q=throughput', owner.headers, createTestEnv({ AI: undefined }))
    )
    expect(res.hits).toEqual([])
  })
})

describe('Ask the Guide', () => {
  it('streams an answer that searched the guide, ending with a resolved citation event', async () => {
    await syncGuide(makeJobCtx({ db }), bundle)
    const env = createTestEnv()
    const calls = scriptPlatformChat(env, [
      { toolCalls: [{ id: 'c1', name: 'search_guide', input: { query: 'invitation' } }] },
      {
        text: 'Open **People** and choose **Invite**.\n\nCITATIONS:\npage=admin/people.md | heading=do-it | note=sending an invitation\npage=start/none.md | heading=- | note=made up',
      },
    ])
    const admin = await as('admin')
    const res = await request(
      '/api/guide/ask',
      { method: 'POST', headers: { ...admin.headers, 'X-Requested-With': 'fetch' } },
      { env, json: { question: 'How do I add someone?', screen: { route: '/settings/people' } } }
    )
    expect(res.status).toBe(200)
    const frames = await aguiFrames(res)
    expect(aguiTypes(frames)).toContain('TOOL_CALL_RESULT')
    const answer = customEvents(frames).find(e => e.name === GUIDE_ANSWER_EVENT)
      ?.value as GuideAnswer
    expect(answer.answer).toBe('Open **People** and choose **Invite**.')
    expect(answer.retrieval).toBe('hybrid')
    expect(answer.citations).toEqual([
      expect.objectContaining({ page: 'admin/people.md', heading: 'do-it', valid: true }),
      expect.objectContaining({ page: 'start/none.md', valid: false }),
    ])

    // The model was offered search_guide alone, read the passage, and was told the screen.
    const offered = (calls[0]?.tools ?? []).map(t => JSON.stringify(t))
    expect(offered).toHaveLength(1)
    expect(offered[0]).toContain('search_guide')
    expect(JSON.stringify(calls[1]?.messages)).toContain('page=admin/people.md')
    expect(JSON.stringify(calls[0]?.messages)).toContain('(admin/people.md) describes')
    expect(JSON.stringify(calls[0]?.messages)).not.toContain('/settings/people')
  })

  it('a model that writes no CITATIONS block still shows the sections it searched', async () => {
    await syncGuide(makeJobCtx({ db }), bundle)
    const env = createTestEnv()
    scriptPlatformChat(env, [
      { toolCalls: [{ id: 'c1', name: 'search_guide', input: { query: 'throughput' } }] },
      { text: 'Each row is one week, newest first.' },
    ])
    const member = await as('member')
    const res = await request(
      '/api/guide/ask',
      { method: 'POST', headers: { ...member.headers, 'X-Requested-With': 'fetch' } },
      { env, json: { question: 'How do I read a report?' } }
    )
    const frames = await aguiFrames(res)
    const answer = customEvents(frames).find(e => e.name === GUIDE_ANSWER_EVENT)
      ?.value as GuideAnswer
    expect(answer.answer).toBe('Each row is one week, newest first.')
    expect(answer.citations[0]).toMatchObject({
      page: 'start/reports.md',
      heading: 'reading-a-report',
      note: 'searched',
      valid: true,
    })
    expect(answer.citations.every(c => c.page !== 'admin/people.md')).toBe(true)
  })

  it('refuses an empty question', async () => {
    const member = await as('member')
    const res = await request(
      '/api/guide/ask',
      { method: 'POST', headers: { ...member.headers, 'X-Requested-With': 'fetch' } },
      { json: { question: '' } }
    )
    expect(res.status).toBe(400)
  })
})
