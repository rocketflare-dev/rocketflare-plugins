/**
 * The four GitHub REST calls this plugin makes, and nothing else: search the repository's issues,
 * read one, open one, comment on one. A plain module over `fetch` (injectable, so tests never leave
 * the machine) — no Octokit, which would be a dependency for four requests.
 *
 * The token is read from config by the caller and passed in; it never appears in an error, a log
 * line or anything the agent hands the model.
 */
import {
  type IssueReportsConfig,
  issueReportsConfigSchema,
} from '@rocketflare/shared/plugins/issue-reports/index'
import type { PluginConfig } from '@/plugins/api'

const API = 'https://api.github.com'

export interface GithubIssueRef {
  number: number
  title: string
  state: 'open' | 'closed'
  url: string
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

export interface GithubClient {
  readonly repo: string
  searchIssues(query: string, limit?: number): Promise<GithubIssueRef[]>
  /** `null` for an issue that does not exist (or is a pull request). */
  getIssue(issueNumber: number): Promise<GithubIssueRef | null>
  createIssue(input: { title: string; body: string }): Promise<GithubIssueRef>
  commentOnIssue(issueNumber: number, body: string): Promise<{ url: string }>
}

type Fetch = typeof fetch

export function issueReportsConfig(config: PluginConfig): IssueReportsConfig {
  return issueReportsConfigSchema.parse(config)
}

/** The client, or `null` when the deployment has not named both a repository and a token. */
export function githubFor(config: PluginConfig, fetchImpl: Fetch = fetch): GithubClient | null {
  const { ISSUE_REPORTS_GITHUB_TOKEN: token, ISSUE_REPORTS_GITHUB_REPO: repo } =
    issueReportsConfig(config)
  if (!token || !repo) return null
  return createGithubClient({ token, repo, fetch: fetchImpl })
}

interface RawIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  html_url: string
  pull_request?: unknown
}

const toRef = (issue: RawIssue): GithubIssueRef => ({
  number: issue.number,
  title: issue.title,
  state: issue.state,
  url: issue.html_url,
})

export function createGithubClient(options: {
  token: string
  repo: string
  fetch?: Fetch
}): GithubClient {
  const doFetch = options.fetch ?? fetch
  const { repo } = options

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await doFetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub refuses a request with no User-Agent.
        'User-Agent': 'rocketflare-issue-reports',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    if (!res.ok) {
      // The status and GitHub's own message only: the response never echoes the token, and the
      // request (which carries it) is not included.
      const detail = await res
        .json()
        .then(body => (body as { message?: string }).message)
        .catch(() => undefined)
      throw new GithubError(`GitHub ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
    }
    return (await res.json()) as T
  }

  return {
    repo,
    async searchIssues(query, limit = 8) {
      const q = `repo:${repo} is:issue ${query.replace(/\s+/g, ' ').trim()}`
      const params = new URLSearchParams({ q, per_page: String(limit) })
      const body = await call<{ items: RawIssue[] }>(`/search/issues?${params}`)
      return body.items.filter(item => !item.pull_request).map(toRef)
    },
    async getIssue(issueNumber) {
      try {
        const issue = await call<RawIssue>(`/repos/${repo}/issues/${issueNumber}`)
        return issue.pull_request ? null : toRef(issue)
      } catch (err) {
        if (err instanceof GithubError && (err.status === 404 || err.status === 410)) return null
        throw err
      }
    },
    async createIssue({ title, body }) {
      return toRef(
        await call<RawIssue>(`/repos/${repo}/issues`, { method: 'POST', body: { title, body } })
      )
    },
    async commentOnIssue(issueNumber, body) {
      const comment = await call<{ html_url: string }>(
        `/repos/${repo}/issues/${issueNumber}/comments`,
        { method: 'POST', body: { body } }
      )
      return { url: comment.html_url }
    },
  }
}
