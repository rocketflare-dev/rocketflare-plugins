---
version: unreleased
previous: null
date: null
breaking: false
migrations: []
areas: [shared, api, ui, docs]
touches_surfaces: []
requires_surfaces: [feature-agents]
manual: true
---

## What changed

The first release: Ideas & issues, where anyone on the team talks a bug or an idea through with an agent that asks until it is clear, checks for an existing issue, and logs it on GitHub once they approve the draft.

- **Ideas & issues** page (`/ideas-and-issues`, nav group "Feedback"), guarded by the kit's `create AgentRun`, so every role can use it. "Shared by you" lists the person's own conversations.
- Each conversation is ONE run of the non-exclusive `issue-reports` agent: questions are `input` interrupts, each draft a `choice` interrupt, so the run parks between turns and needs no table. The loop is code keyed by round number (`ctx.once('turn:<n>')`, `ctx.interrupt({ key: 'ask:<n>' })`), and the filing sits behind `ctx.once('github:file')`, so a replayed or retried step never asks twice or files twice.
- Nothing reaches GitHub until the person picks "Log it on GitHub"; anything else they type at the review is a change the agent redrafts from. A duplicate the person confirms becomes a comment on the existing issue.
- The issue body is the agent's Markdown summary, who reported it and from which page, then the whole conversation under `<details>`. No labels and no assignee.
- `GET /api/issue-reports/status` answers `{ configured, repo }`, never the token.
- The prompt `issue-reports` can be overridden per organisation in Settings → Prompts, and its model chosen in Settings → agent models.
- Two config keys, both declared as secrets so the plugin needs no toml edit: `ISSUE_REPORTS_GITHUB_REPO` (`owner/name`) and `ISSUE_REPORTS_GITHUB_TOKEN`. With either missing, the page says it is off and the agent refuses to start.

## How to apply

1. Confirm the kit is 0.21.0 or later, the first release where a plugin agent can `interrupt` a person, read its `chatModel` and run non-exclusively.
2. Run `pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/issue-reports`, read the plan, then re-run it with `--apply`.
3. Run `pnpm install` for `react-markdown` and `remark-gfm` in `apps/web`. The plugin has no tables, so there is no migration to generate.
4. Add `ISSUE_REPORTS_GITHUB_REPO=` and `ISSUE_REPORTS_GITHUB_TOKEN=` to `apps/web/.dev.vars.example`, and set both in `apps/web/.dev.vars`.
5. Create a fine-grained GitHub token with Issues: read and write on that one repository, then run `wrangler secret put ISSUE_REPORTS_GITHUB_REPO` (`owner/name`) and `wrangler secret put ISSUE_REPORTS_GITHUB_TOKEN` per environment. A host may put the repository under `[vars]` in BOTH tomls instead; it is not sensitive.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` reports `issue-reports` checks out.
2. `pnpm test` passes, including `src/plugins/issue-reports/tests/**`.
3. With both set, `GET /api/issue-reports/status` answers `{"configured":true,"repo":"<owner/name>"}`; with either missing it answers `configured: false` and the page says Ideas & issues is off.
4. On `/ideas-and-issues`, describe a problem, answer the agent's questions and pick "Log it on GitHub": an issue opens in that repository with the conversation folded under "Full conversation".
