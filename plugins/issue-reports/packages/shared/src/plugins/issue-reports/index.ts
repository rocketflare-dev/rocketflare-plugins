/**
 * `issue-reports` — the shared half (D31): a teammate describes a problem or an idea, an agent asks
 * until it understands what they need, and — once they say so — logs it as a GitHub issue (or a
 * comment on the issue it duplicates) in the repository the deployment names.
 *
 * Each conversation is ONE agent run of the `issue-reports` agent, which is **non-exclusive**: a
 * person's conversation parks on their answer, and a dozen people may be mid-way at once. So there
 * is no table here — the run is the record: its input is what they first said, its asks and answers
 * are the conversation, its output is the issue it filed.
 *
 * Everything keyed carries the id: the agent and prompt key `issue-reports`, the API prefix
 * `/api/issue-reports`, the query-key roots `issue-reports:…`, the config keys `ISSUE_REPORTS_*`.
 * (Not `feedback` — the kit already owns `/api/feedback`, the `Feedback` subject and that CLI word.)
 */
import { z } from 'zod'
import type { SharedPlugin } from '../types'

export const ISSUE_REPORTS_ID = 'issue-reports'
export const ISSUE_REPORTS_AGENT_KEY = 'issue-reports'
export const ISSUE_REPORTS_PROMPT_KEY = 'issue-reports'
export const ISSUE_REPORTS_API_ROOT = '/api/issue-reports'

/** What a person may type as the opening description. */
export const ISSUE_REPORT_DESCRIPTION_MAX = 4_000
/** Where they were when they opened it — a path inside the app, never a full URL. */
export const ISSUE_REPORT_PAGE_PATH_MAX = 300
/** One agent question shown in the conversation. Well under the interrupt's own 4 000 cap. */
export const ISSUE_REPORT_QUESTION_MAX = 1_500
export const ISSUE_REPORT_TITLE_MAX = 120
/** The drafted summary. The review ask carries it, so it stays under the interrupt's 4 000 cap. */
export const ISSUE_REPORT_DRAFT_BODY_MAX = 3_200
/** Model turns per conversation: questions, searches and redrafts together. */
export const ISSUE_REPORT_MAX_ROUNDS = 16

/** The review ask's one offered answer; anything else typed there is a requested change. */
export const ISSUE_REPORT_FILE_CHOICE = 'file'

export const ISSUE_REPORT_KINDS = ['bug', 'enhancement', 'question'] as const
export const issueReportKindSchema = z.enum(ISSUE_REPORT_KINDS)
export type IssueReportKind = z.infer<typeof issueReportKindSchema>

/** `owner/name` — the only shape the GitHub REST paths take. */
export const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// ---- Config --------------------------------------------------------------------------------------

const optional = z
  .string()
  .trim()
  .optional()
  .transform(value => (value ? value : undefined))

/**
 * Either unset → the feature is off: the page says so, and an agent run fails before asking anything.
 * Both are declared as secrets (`wrangler secret put`), so the plugin needs no toml edit; the repo is
 * not sensitive and a host may put it under `[vars]` instead. The token is never a `[vars]` entry.
 */
export const issueReportsConfigShape = {
  /** Fine-grained PAT (or GitHub App token) with Issues: read & write on the one repository. */
  ISSUE_REPORTS_GITHUB_TOKEN: optional,
  /** `owner/name` of the repository issues are logged in. */
  ISSUE_REPORTS_GITHUB_REPO: optional.refine(value => !value || GITHUB_REPO_RE.test(value), {
    message: 'must be owner/name',
  }),
} satisfies z.ZodRawShape

export const issueReportsConfigSchema = z.object(issueReportsConfigShape)
export type IssueReportsConfig = z.infer<typeof issueReportsConfigSchema>

// ---- The agent's contract ---------------------------------------------------------------------

export const issueReportInputSchema = z.object({
  description: z.string().trim().min(1).max(ISSUE_REPORT_DESCRIPTION_MAX),
  /** The in-app path they came from (`/orders/calendar`), when the page knew it. */
  pagePath: z
    .string()
    .trim()
    .max(ISSUE_REPORT_PAGE_PATH_MAX)
    .regex(/^\//, 'must be a path inside the app')
    .optional(),
})
export type IssueReportInput = z.infer<typeof issueReportInputSchema>

export const issueReportOutputSchema = z.object({
  /** `created` a new issue, `commented` on the one it duplicates, or `discarded` by the person. */
  outcome: z.enum(['created', 'commented', 'discarded']),
  kind: issueReportKindSchema.nullable(),
  title: z.string().nullable(),
  issueNumber: z.number().int().positive().nullable(),
  issueUrl: z.string().url().nullable(),
})
export type IssueReportOutput = z.infer<typeof issueReportOutputSchema>

/**
 * The draft as the review ask shows it. `comment` adds to an existing issue the agent found and
 * the person agreed is the same thing; its `title` is that issue's.
 */
export const issueReportDraftSchema = z.object({
  mode: z.enum(['new', 'comment']),
  kind: issueReportKindSchema,
  title: z.string().trim().min(1).max(ISSUE_REPORT_TITLE_MAX),
  body: z.string().trim().min(1).max(ISSUE_REPORT_DRAFT_BODY_MAX),
  existingIssueNumber: z.number().int().positive().optional(),
})
export type IssueReportDraft = z.infer<typeof issueReportDraftSchema>

// ---- Routes ------------------------------------------------------------------------------------

/** `GET /api/issue-reports/status` — whether a conversation can end in an issue at all. */
export const issueReportsStatusSchema = z.object({
  configured: z.boolean(),
  repo: z.string().nullable(),
})
export type IssueReportsStatus = z.infer<typeof issueReportsStatusSchema>

// ---- The plugin ----------------------------------------------------------------------------------

export const issueReportsShared = {
  id: ISSUE_REPORTS_ID,
  label: 'Issue reports',
  version: '3.4.2',
  agentKeys: [ISSUE_REPORTS_AGENT_KEY],
  promptKeys: [ISSUE_REPORTS_PROMPT_KEY],
  config: issueReportsConfigShape,
} as const satisfies SharedPlugin
