/**
 * `/api/issue-reports` — one read, for the page: can a conversation end in a GitHub issue here?
 *
 *   GET /status    create AgentRun — `{ configured, repo }`
 *
 * Everything else is the kit's own agent-run API (`/api/agents/runs…`): starting a conversation is
 * `POST /api/agents/runs { agentKey: 'issue-reports' }`, answering is the interrupt route, and the
 * list of your reports is `GET /api/agents/runs?agentKey=issue-reports` — members see their own.
 * The token never leaves the server; only whether there is one does.
 */
import type { IssueReportsStatus } from '@rocketflare/shared/plugins/issue-reports/index'
import type { RequestCtx } from '@/plugins/api'
import { createRouter, requestCtx } from '@/plugins/api'
import { githubFor, issueReportsConfig } from '../services/github'

export const issueReportsRouter = createRouter()

issueReportsRouter.get('/status', c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('create', 'AgentRun')
  const configured = githubFor(ctx.config) !== null
  const body: IssueReportsStatus = {
    configured,
    repo: configured ? (issueReportsConfig(ctx.config).ISSUE_REPORTS_GITHUB_REPO ?? null) : null,
  }
  return c.json(body)
})
