/**
 * `issue-reports` — the SERVER entry (D31): talk a bug or an idea through with an agent, then log
 * it on GitHub.
 *
 * Read this file and you have the whole server half: one non-exclusive agent (each person's
 * conversation is its own run, parked on their answers), its prompt, and a status route. No table,
 * no job, no grants — starting and answering a run is the kit's `AgentRun` permission, which every
 * role has for its own runs. The GitHub token is a secret read from config at the moment of use.
 */
import {
  ISSUE_REPORTS_AGENT_KEY,
  ISSUE_REPORTS_API_ROOT,
  ISSUE_REPORTS_PROMPT_KEY,
  issueReportsShared,
} from '@rocketflare/shared/plugins/issue-reports/index'
import type { ServerPlugin } from '@/plugins/api'
import { issueReportsAgent } from './agent/refine'
import { issueReportsRouter } from './api/router'
import { issueReportsPrompt } from './prompts'

export const issueReportsServer = {
  shared: issueReportsShared,
  mounts: [[ISSUE_REPORTS_API_ROOT, issueReportsRouter]],
  agents: { [ISSUE_REPORTS_AGENT_KEY]: issueReportsAgent },
  prompts: { [ISSUE_REPORTS_PROMPT_KEY]: issueReportsPrompt },
} satisfies ServerPlugin<typeof issueReportsShared>
