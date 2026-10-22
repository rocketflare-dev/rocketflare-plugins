/**
 * The `issue-reports` agent, driven the way the runtime drives it: `run()` is RE-ENTERED from the
 * top every time the person answers, with `once` replaying what was recorded and `interrupt`
 * answering what was asked. The fake context below is that contract and nothing more — a park is
 * an exception, a resume is calling `runIssueReport` again over the same stores.
 *
 * What it proves: one model call per round however many times the run re-enters (so a resume never
 * re-asks or re-bills), nothing reaches GitHub until the person picks "Log it", a requested change
 * is redrafted, a duplicate becomes a comment, and declining files nothing.
 */
import type { IssueReportInput } from '@rocketflare/shared/plugins/issue-reports/index'
import { ISSUE_REPORT_FILE_CHOICE } from '@rocketflare/shared/plugins/issue-reports/index'
import { describe, expect, it } from 'vitest'
import type { AgentCtx, AgentInterruptAnswer, AgentInterruptAsk, PluginConfig } from '@/plugins/api'
import { runIssueReport } from '../../agent/refine'

class Parked extends Error {
  constructor(readonly key: string) {
    super(`parked on ${key}`)
  }
}

interface FetchCall {
  method: string
  url: string
  body: unknown
}

function fakeGithub() {
  const calls: FetchCall[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const path = new URL(url).pathname
    const reply = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    if (path === '/search/issues') {
      return reply({
        items: [
          {
            number: 12,
            title: 'Calendar shows a moved order on the old day',
            state: 'open',
            html_url: 'https://github.com/acme/app/issues/12',
          },
        ],
      })
    }
    if (method === 'GET' && path === '/repos/acme/app/issues/12') {
      return reply({
        number: 12,
        title: 'Calendar shows a moved order on the old day',
        state: 'open',
        html_url: 'https://github.com/acme/app/issues/12',
      })
    }
    if (method === 'GET' && path.startsWith('/repos/acme/app/issues/')) {
      return reply({ message: 'Not Found' }, 404)
    }
    if (method === 'POST' && path === '/repos/acme/app/issues') {
      return reply({
        number: 99,
        title: (body as { title: string }).title,
        state: 'open',
        html_url: 'https://github.com/acme/app/issues/99',
      })
    }
    if (method === 'POST' && path === '/repos/acme/app/issues/12/comments') {
      return reply({ html_url: 'https://github.com/acme/app/issues/12#issuecomment-1' })
    }
    return reply({ message: 'unexpected' }, 500)
  }) as typeof fetch
  return { calls, fetch: fetchImpl, writes: () => calls.filter(c => c.method === 'POST') }
}

const CONFIGURED = {
  ISSUE_REPORTS_GITHUB_TOKEN: 'ghp_test',
  ISSUE_REPORTS_GITHUB_REPO: 'acme/app',
} as unknown as PluginConfig

const INPUT: IssueReportInput = {
  description: 'The calendar is wrong after I move an order.',
  pagePath: '/orders/calendar',
}

const DRAFT = {
  mode: 'new',
  kind: 'bug',
  title: 'Moved order still shows on its old day',
  body: 'Summary.\n\n**Steps to reproduce**\n1. Move an order',
}

/** A conversation: scripted model turns, and the person's answers keyed by the ask's key. */
function conversation(script: unknown[], config: PluginConfig = CONFIGURED) {
  const recorded = new Map<string, unknown>()
  const answers = new Map<string, unknown>()
  const asks: AgentInterruptAsk[] = []
  let modelCalls = 0
  const github = fakeGithub()

  const ctx = {
    db: {},
    config,
    env: {},
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    tenantId: '00000000-0000-4000-8000-000000000001',
    runId: '00000000-0000-4000-8000-000000000002',
    userId: null,
    input: INPUT,
    tools: [],
    prompt: async () => 'You help.',
    step: async () => {},
    checkCancelled: async () => {},
    once: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      // jsonb round trip, as the real `agent_run_effects` row gives it back
      if (!recorded.has(key)) recorded.set(key, JSON.parse(JSON.stringify(await fn())))
      return recorded.get(key) as T
    },
    structured: async (options: {
      tool: { schema: { parse: (v: unknown) => unknown } }
      onUsage?: (u: { inputTokens: number; outputTokens: number }) => void
    }) => {
      const turn = script[modelCalls]
      modelCalls += 1
      if (turn === undefined) throw new Error('the script ran out')
      options.onUsage?.({ inputTokens: 1, outputTokens: 1 })
      return options.tool.schema.parse(turn)
    },
    toolLoop: async () => {
      throw new Error('not used')
    },
    decide: {},
    interrupt: async (ask: AgentInterruptAsk): Promise<AgentInterruptAnswer> => {
      if (!asks.some(a => a.key === ask.key)) asks.push(ask)
      if (!answers.has(ask.key)) throw new Parked(ask.key)
      const answer = answers.get(ask.key)
      return answer === 'decline'
        ? { interruptId: ask.key, status: 'cancelled', payload: null, resolvedByUserId: null }
        : { interruptId: ask.key, status: 'resolved', payload: answer, resolvedByUserId: null }
    },
    chatModel: { provider: 'anthropic', model: 'fake' },
  } as unknown as AgentCtx<IssueReportInput>

  return {
    github,
    asks,
    modelCalls: () => modelCalls,
    answer: (key: string, payload: unknown) => answers.set(key, payload),
    /** Run until it parks (→ the key it waits on) or finishes (→ its output). */
    run: async () => {
      try {
        return { output: await runIssueReport(ctx, { fetch: github.fetch }) }
      } catch (err) {
        if (err instanceof Parked) return { parkedOn: err.key }
        throw err
      }
    },
  }
}

describe('issue-reports agent', () => {
  it('asks, searches, drafts, and files only once the person says so — one model call per round', async () => {
    const c = conversation([
      { action: 'ask', question: 'Which day did you move it to, and did a refresh fix it?' },
      { action: 'search', query: 'calendar moved order' },
      { action: 'draft', draft: DRAFT },
    ])

    expect(await c.run()).toEqual({ parkedOn: 'ask:0' })
    expect(c.asks[0]?.spec).toMatchObject({
      kind: 'input',
      message: expect.stringContaining('Which day'),
    })

    c.answer('ask:0', { text: 'Tuesday to Thursday. Refreshing fixed it.' })
    expect(await c.run()).toEqual({ parkedOn: 'review:2' })
    expect(c.asks[1]?.spec).toMatchObject({
      kind: 'choice',
      options: [{ value: ISSUE_REPORT_FILE_CHOICE, label: 'Log it on GitHub' }],
      allowOther: true,
    })
    // A search, but no write: nothing is filed before the person agrees.
    expect(c.github.writes()).toEqual([])

    c.answer('review:2', { value: ISSUE_REPORT_FILE_CHOICE })
    const done = await c.run()
    expect(done).toEqual({
      output: {
        outcome: 'created',
        kind: 'bug',
        title: DRAFT.title,
        issueNumber: 99,
        issueUrl: 'https://github.com/acme/app/issues/99',
      },
    })
    // Three rounds, three model calls, across three entries into run().
    expect(c.modelCalls()).toBe(3)

    const [created] = c.github.writes()
    expect(created?.url).toBe('https://api.github.com/repos/acme/app/issues')
    const body = created?.body as { title: string; body: string; labels?: unknown }
    expect(body.title).toBe(DRAFT.title)
    expect(body.labels).toBeUndefined()
    expect(body.body).toContain('**Steps to reproduce**')
    expect(body.body).toContain('**Page:** `/orders/calendar`')
    expect(body.body).toContain('<summary>Full conversation</summary>')
    expect(body.body).toContain('> Tuesday to Thursday. Refreshing fixed it.')

    // A retried step after filing replays the recorded issue rather than opening a second.
    await c.run()
    expect(c.github.writes()).toHaveLength(1)
  })

  it('a requested change is redrafted and reviewed again', async () => {
    const c = conversation([
      { action: 'draft', draft: DRAFT },
      {
        action: 'draft',
        draft: { ...DRAFT, title: 'Calendar keeps a moved order until refresh' },
      },
    ])
    expect(await c.run()).toEqual({ parkedOn: 'review:0' })
    c.answer('review:0', { value: 'Say it only happens until you refresh.' })
    expect(await c.run()).toEqual({ parkedOn: 'review:1' })
    c.answer('review:1', { value: ISSUE_REPORT_FILE_CHOICE })
    const done = await c.run()
    expect(done.output?.title).toBe('Calendar keeps a moved order until refresh')
    expect(c.github.writes()).toHaveLength(1)
  })

  it('a duplicate becomes a comment on the existing issue, titled from GitHub', async () => {
    const c = conversation([
      { action: 'draft', draft: { ...DRAFT, mode: 'comment', existingIssueNumber: 12 } },
    ])
    expect(await c.run()).toEqual({ parkedOn: 'review:0' })
    expect(c.asks[0]?.spec).toMatchObject({
      title: 'Add this to #12 — Calendar shows a moved order on the old day?',
    })
    c.answer('review:0', { value: ISSUE_REPORT_FILE_CHOICE })
    const done = await c.run()
    expect(done.output).toMatchObject({ outcome: 'commented', issueNumber: 12 })
    const [comment] = c.github.writes()
    expect(comment?.url).toBe('https://api.github.com/repos/acme/app/issues/12/comments')
    expect((comment?.body as { body: string } | undefined)?.body).toMatch(
      /^\*\*Also reported by A teammate\.\*\*/
    )
  })

  it('a comment on an issue that does not exist goes back to the model, not to the person', async () => {
    const c = conversation([
      { action: 'draft', draft: { ...DRAFT, mode: 'comment', existingIssueNumber: 404 } },
      { action: 'draft', draft: DRAFT },
    ])
    expect(await c.run()).toEqual({ parkedOn: 'review:1' })
    expect(c.asks).toHaveLength(1)
  })

  it('declining the draft files nothing', async () => {
    const c = conversation([{ action: 'draft', draft: DRAFT }])
    await c.run()
    c.answer('review:0', 'decline')
    const done = await c.run()
    expect(done.output).toMatchObject({ outcome: 'discarded', issueNumber: null })
    expect(c.github.writes()).toEqual([])
  })

  it('refuses to start without a repository and a token', async () => {
    const c = conversation([], {} as PluginConfig)
    await expect(c.run()).rejects.toThrow(/not set up/)
  })
})
