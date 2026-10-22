/**
 * The `issue-reports` agent: from "the calendar is annoying" to a GitHub issue somebody can act on.
 *
 * One ROUND is one model decision — ask the person something, search the repository's issues, or
 * draft — and the loop below is plain code, not a model-driven tool loop, for one reason: a run
 * that parks on a person RE-ENTERS `run()` from the top when they answer, so every step before the
 * park must replay exactly. Each decision is recorded with `ctx.once('turn:<n>')` and each question
 * is asked with `ctx.interrupt({ key: 'ask:<n>' })`, both keyed by the round number this code
 * controls — never by model text, which could differ on a replay and ask the person twice.
 *
 * Nothing reaches GitHub until the person picks "Log it" on the review ask; anything else they
 * type there is a change the agent redrafts from. Searches are read-only and happen whenever the
 * agent wants to check for a duplicate. The filing itself is behind `ctx.once('github:file')`, so a
 * retried step never opens the issue twice.
 */
import { choicePayloadSchema } from '@rocketflare/shared/ai/interrupts'
import {
  ISSUE_REPORT_FILE_CHOICE,
  ISSUE_REPORT_MAX_ROUNDS,
  ISSUE_REPORT_QUESTION_MAX,
  ISSUE_REPORTS_AGENT_KEY,
  ISSUE_REPORTS_PROMPT_KEY,
  type IssueReportDraft,
  type IssueReportInput,
  type IssueReportOutput,
  issueReportDraftSchema,
  issueReportInputSchema,
  issueReportOutputSchema,
} from '@rocketflare/shared/plugins/issue-reports/index'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { users } from '@/db/schema/kit'
import type { AgentCtx, PluginAgent } from '@/plugins/api'
import { agentCtx, recordUsage } from '@/plugins/api'
import { type GithubClient, type GithubIssueRef, githubFor } from '../services/github'
import { buildIssueBody, type TranscriptEntry } from '../services/issue-body'

/** What happened in one round, replayed from the run's own records on every re-entry. */
export type Step =
  | { kind: 'ask'; question: string; answer: string | null }
  | { kind: 'search'; query: string; results: GithubIssueRef[] | null; error?: string }
  | { kind: 'missing'; issueNumber: number }
  | { kind: 'review'; draft: IssueReportDraft; changes: string }

export function respondSchemaFor(lastRound: boolean) {
  const draft = issueReportDraftSchema.describe(
    'The issue as you would file it. `body` is Markdown written for the developer who picks it up.'
  )
  if (lastRound) return z.object({ action: z.literal('draft'), draft })
  return z
    .object({
      action: z
        .enum(['ask', 'search', 'draft'])
        .describe(
          'ask = one question to the person; search = look for existing issues; draft = show them the issue'
        ),
      question: z
        .string()
        .trim()
        .min(1)
        .max(ISSUE_REPORT_QUESTION_MAX)
        .optional()
        .describe('action=ask: ONE short question, in plain language.'),
      query: z
        .string()
        .trim()
        .min(2)
        .max(200)
        .optional()
        .describe(
          'action=search: a few keywords, as you would type them into GitHub issue search.'
        ),
      draft: draft.optional().describe('action=draft: the issue.'),
    })
    .superRefine((value, issue) => {
      const needed = { ask: 'question', search: 'query', draft: 'draft' } as const
      const field = needed[value.action]
      if (value[field] === undefined) {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `action "${value.action}" needs ${field}`,
        })
      }
      if (value.draft?.mode === 'comment' && !value.draft.existingIssueNumber) {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['draft', 'existingIssueNumber'],
          message: 'a comment needs the existing issue number',
        })
      }
    })
}

type Respond = z.infer<ReturnType<typeof respondSchemaFor>>

const draftText = (draft: IssueReportDraft): string =>
  `${draft.mode === 'comment' ? `Comment on #${draft.existingIssueNumber}` : 'New issue'} (${draft.kind}): ${draft.title}\n\n${draft.body}`

/** The conversation as the model reads it: strictly alternating, starting and ending with `user`. */
export function buildMessages(
  input: IssueReportInput,
  reporterName: string,
  steps: readonly Step[]
): { role: 'user' | 'assistant'; content: string }[] {
  const where = input.pagePath ? ` (they were on the page ${input.pagePath})` : ''
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: `${reporterName} reported this${where}:\n\n${input.description}` },
  ]
  for (const step of steps) {
    switch (step.kind) {
      case 'ask':
        messages.push({ role: 'assistant', content: step.question })
        messages.push({
          role: 'user',
          content: step.answer ?? '(They chose not to answer. Carry on without it.)',
        })
        break
      case 'search': {
        messages.push({
          role: 'assistant',
          content: `(Searching existing issues for "${step.query}".)`,
        })
        const found = step.results
          ? step.results.length
            ? step.results.map(r => `#${r.number} [${r.state}] ${r.title}`).join('\n')
            : 'No matching issues.'
          : `The search failed (${step.error ?? 'unknown error'}). Do not search again; carry on.`
        messages.push({
          role: 'user',
          content: `[Search results — from GitHub, not from the person]\n${found}`,
        })
        break
      }
      case 'missing':
        messages.push({ role: 'assistant', content: `(Looking up #${step.issueNumber}.)` })
        messages.push({
          role: 'user',
          content: `[From GitHub] Issue #${step.issueNumber} does not exist. Do not comment on it.`,
        })
        break
      case 'review':
        messages.push({ role: 'assistant', content: `I drafted:\n\n${draftText(step.draft)}` })
        messages.push({ role: 'user', content: `Please change this: ${step.changes}` })
        break
    }
  }
  return messages
}

/** The conversation as it is filed: what the person said and what they were asked. */
export function transcriptOf(input: IssueReportInput, steps: readonly Step[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [{ speaker: 'reporter', text: input.description }]
  for (const step of steps) {
    if (step.kind === 'ask') {
      out.push({ speaker: 'agent', text: step.question })
      out.push({ speaker: 'reporter', text: step.answer ?? '_(skipped)_' })
    } else if (step.kind === 'review') {
      out.push({ speaker: 'agent', text: `Drafted: ${step.draft.title}` })
      out.push({ speaker: 'reporter', text: step.changes })
    }
  }
  return out
}

async function reporterNameOf(ctx: AgentCtx<IssueReportInput>): Promise<string> {
  if (!ctx.userId) return 'A teammate'
  const [row] = await ctx.db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1)
  return row?.name?.trim() || row?.email?.split('@')[0] || 'A teammate'
}

async function decide(
  ctx: AgentCtx<IssueReportInput>,
  system: string,
  messages: ReturnType<typeof buildMessages>,
  lastRound: boolean
): Promise<Respond> {
  let usage: Parameters<typeof recordUsage>[1]['usage'] | null = null
  const answer = await ctx.structured({
    system: lastRound
      ? `${system}\n\nThis is your LAST turn: draft the issue now from what you have.`
      : system,
    messages,
    tool: {
      name: 'respond',
      description: 'Your next move in this conversation.',
      schema: respondSchemaFor(lastRound) as z.ZodType<Respond>,
    },
    onUsage: u => {
      usage = u
    },
  })
  if (usage) {
    await recordUsage(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      feature: `agent:${ISSUE_REPORTS_AGENT_KEY}`,
      provider: ctx.chatModel.provider,
      model: ctx.chatModel.model,
      usage,
    }).catch(err => ctx.logger.warn({ err }, 'issue-reports: usage write failed'))
  }
  return answer
}

async function search(github: GithubClient, query: string): Promise<Step> {
  try {
    return { kind: 'search', query, results: await github.searchIssues(query) }
  } catch (err) {
    return {
      kind: 'search',
      query,
      results: null,
      error: err instanceof Error ? err.message : 'unknown error',
    }
  }
}

const discarded = (draft: IssueReportDraft | null): IssueReportOutput => ({
  outcome: 'discarded',
  kind: draft?.kind ?? null,
  title: draft?.title ?? null,
  issueNumber: null,
  issueUrl: null,
})

export async function runIssueReport(
  ctx: AgentCtx<IssueReportInput>,
  /** Tests hand GitHub a recording `fetch`; the runtime never passes one. */
  deps: { fetch?: typeof fetch } = {}
): Promise<IssueReportOutput> {
  const github = githubFor(ctx.config, deps.fetch)
  if (!github) {
    throw new Error(
      'Ideas & issues is not set up: ISSUE_REPORTS_GITHUB_REPO and ISSUE_REPORTS_GITHUB_TOKEN are both needed.'
    )
  }
  const input = ctx.input
  const system = await ctx.prompt({ repo: github.repo })
  const reporterName = await reporterNameOf(ctx)
  const steps: Step[] = []
  let lastDraft: IssueReportDraft | null = null

  for (let round = 0; round < ISSUE_REPORT_MAX_ROUNDS; round++) {
    await ctx.checkCancelled()
    const lastRound = round === ISSUE_REPORT_MAX_ROUNDS - 1
    const next = await ctx.once(`turn:${round}`, () =>
      decide(ctx, system, buildMessages(input, reporterName, steps), lastRound)
    )

    if (next.action === 'search' && 'query' in next && next.query) {
      const query = next.query
      const step = await ctx.once(`search:${round}`, () => search(github, query))
      const found =
        step.kind === 'search' && step.results ? `${step.results.length} found` : 'failed'
      await ctx.step(`search:${round}`, `Searched GitHub for “${query}”`, 'done', found)
      steps.push(step)
      continue
    }

    if (next.action === 'ask' && 'question' in next && next.question) {
      const answer = await ctx.interrupt({
        key: `ask:${round}`,
        spec: {
          kind: 'input',
          title: 'A question about your report',
          message: next.question,
          multiline: true,
          placeholder: 'Your answer',
        },
      })
      const text =
        answer.status === 'resolved'
          ? (z.object({ text: z.string() }).safeParse(answer.payload).data?.text ?? null)
          : null
      steps.push({ kind: 'ask', question: next.question, answer: text })
      continue
    }

    if (!next.draft) continue
    let draft: IssueReportDraft = next.draft
    if (draft.mode === 'comment' && draft.existingIssueNumber) {
      const issueNumber = draft.existingIssueNumber
      const existing = await ctx.once(`issue:${round}`, () => github.getIssue(issueNumber))
      if (!existing) {
        steps.push({ kind: 'missing', issueNumber })
        continue
      }
      draft = { ...draft, title: existing.title }
    }
    lastDraft = draft

    const review = await ctx.interrupt({
      key: `review:${round}`,
      spec: {
        kind: 'choice',
        title:
          draft.mode === 'comment'
            ? `Add this to #${draft.existingIssueNumber} — ${draft.title}?`
            : `Log this ${draft.kind} on GitHub?`,
        message: draftText(draft),
        options: [
          {
            value: ISSUE_REPORT_FILE_CHOICE,
            label:
              draft.mode === 'comment'
                ? `Add it to #${draft.existingIssueNumber}`
                : 'Log it on GitHub',
          },
        ],
        allowOther: true,
      },
    })
    if (review.status !== 'resolved') return discarded(draft)
    const choice = choicePayloadSchema.safeParse(review.payload)
    if (!choice.success) return discarded(draft)
    if (choice.data.value === ISSUE_REPORT_FILE_CHOICE) {
      return await file(ctx, github, { input, steps, draft, reporterName })
    }
    steps.push({ kind: 'review', draft, changes: choice.data.value })
  }
  return discarded(lastDraft)
}

async function file(
  ctx: AgentCtx<IssueReportInput>,
  github: GithubClient,
  report: {
    input: IssueReportInput
    steps: readonly Step[]
    draft: IssueReportDraft
    reporterName: string
  }
): Promise<IssueReportOutput> {
  const { draft } = report
  const body = buildIssueBody({
    draft,
    reporterName: report.reporterName,
    pagePath: report.input.pagePath,
    transcript: transcriptOf(report.input, report.steps),
  })
  const filed = await ctx.once('github:file', async () => {
    if (draft.mode === 'comment' && draft.existingIssueNumber) {
      const comment = await github.commentOnIssue(draft.existingIssueNumber, body)
      return { issueNumber: draft.existingIssueNumber, url: comment.url }
    }
    const issue = await github.createIssue({ title: draft.title, body })
    return { issueNumber: issue.number, url: issue.url }
  })
  await ctx.step(
    'github:file',
    draft.mode === 'comment'
      ? `Commented on #${filed.issueNumber}`
      : `Opened #${filed.issueNumber}`,
    'done',
    filed.url
  )
  return {
    outcome: draft.mode === 'comment' ? 'commented' : 'created',
    kind: draft.kind,
    title: draft.title,
    issueNumber: filed.issueNumber,
    issueUrl: filed.url,
  }
}

export const issueReportsAgent: PluginAgent<IssueReportInput, IssueReportOutput> = {
  meta: {
    key: ISSUE_REPORTS_AGENT_KEY,
    title: 'Ideas & issues',
    description:
      'Talks through an idea for an improvement or a problem you found, asks until it is clear, checks for an existing issue, and logs it on GitHub once you approve the draft.',
    inputSchema: issueReportInputSchema,
    outputSchema: issueReportOutputSchema,
    promptKey: ISSUE_REPORTS_PROMPT_KEY,
    // One person's conversation: several people may be mid-way at once.
    exclusive: false,
  },
  run: ctx => runIssueReport(agentCtx(ctx)),
}
