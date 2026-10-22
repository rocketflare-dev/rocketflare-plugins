# issue-reports

> Ideas & issues: anyone on the team talks a bug or an idea through with an agent, which turns it
> into a GitHub issue a developer can pick up without asking anything.

A person describes what they noticed in their own words. The agent asks one plain-language question
at a time until it understands what they actually need, searches the repository for an existing
issue, and shows a draft. Nothing reaches GitHub until they pick **Log it on GitHub**; anything else
they type at that point is a change it redrafts from. If they confirm a duplicate, it comments on
that issue instead of opening a new one.

## What it adds

| Area | What you get |
|---|---|
| UI | **Ideas & issues** (`/ideas-and-issues`, nav group "Feedback"): start a conversation, answer the agent, review the draft, and see the conversations you have shared |
| Agent | `issue-reports`, non-exclusive: each person's conversation is its own run, parked on their answers, so many can be in progress at once |
| Prompt | `issue-reports` — override it per organisation in Settings → Prompts, pick its model in Settings → agent models |
| API | `GET /api/issue-reports/status` → `{ configured, repo }`. Everything else is the kit's own `/api/agents/runs…` |
| GitHub | Four REST calls over `fetch`, with no Octokit: search issues, read one, open one, comment on one |
| Data | None. The agent run is the record: its input is what they first said, its interrupts are the conversation, its output is the issue it filed |

## Requirements

- Rocketflare kit **0.21.0** or later (a plugin agent's `interrupt`, `chatModel` and non-exclusive
  runs).
- The kit's agents surface (`feature-agents`) and a chat model, through any of the kit's AI setups.
- A GitHub repository and a fine-grained token with **Issues: read and write** on that one
  repository.

## Install

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/issue-reports
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/issue-reports --apply
pnpm install
```

The first command prints the plan and stops; `--apply` installs. There are no tables, so there is no
migration to generate.

Then configure it, per environment. Both keys are declared as secrets, so the plugin needs no toml
edit:

```bash
pnpm --filter @<your-app>/web exec wrangler secret put ISSUE_REPORTS_GITHUB_REPO    # owner/name; and --env staging
pnpm --filter @<your-app>/web exec wrangler secret put ISSUE_REPORTS_GITHUB_TOKEN   # and --env staging
```

The repository name is not sensitive. If you would rather keep it in the tomls, add
`ISSUE_REPORTS_GITHUB_REPO = "owner/name"` under `[vars]` in BOTH of them. Locally, add both keys to
`apps/web/.dev.vars.example` and set them in `apps/web/.dev.vars`.

## First run

1. Open **Ideas & issues** from the sidebar. If the repository or the token is missing, the page
   says Ideas & issues is not set up and the form is disabled.
2. Describe a problem or an idea. A page can link here with `?from=<path>` so the issue records
   where the person was.
3. Answer the agent's questions. Usually two to five are enough.
4. Review the draft and pick **Log it on GitHub**, or type what to change.
5. The conversation shows the issue's number and link.

## How it works

- **The loop is code, not a model tool loop.** A parked run re-enters `run()` from the top when the
  person answers, so every step before the park must replay exactly. Each round's decision is
  `ctx.once('turn:<n>')` and each question `ctx.interrupt({ key: 'ask:<n>' })`. Both are keyed by
  the round number, never by model text that could change on a replay. Filing is
  `ctx.once('github:file')`, so a retried step never opens the issue twice.
- **What is filed**: the agent's Markdown summary (a bug gets steps / expected / actual; an
  enhancement gets problem / proposal / acceptance criteria), who reported it and from which page,
  then the whole conversation under `<details>`. If GitHub's 65 536-character limit forces a cut,
  the start of the conversation goes first.
- Model calls are recorded in the kit's usage ledger as `agent:issue-reports`.

## Permissions and data

- Starting and answering a conversation is the kit's `create AgentRun`, which every role has for
  its own runs; members see only their own conversations.
- The token is read from config at the moment of each call. It never appears in an error, a log
  line, a response or anything handed to the model.
- Search results are marked to the model as coming from GitHub, not from the person.

## Known gaps

- A GitHub failure at the moment of filing fails the run. The conversation is kept, but the person
  has to start again.
- No screenshots or attachments.
- In-app only: no Slack or Teams.
- No labels and no assignee. The issue names the reporter, and the team triages on GitHub.
- The page is recorded only when a link carries `?from=`; otherwise it is whatever the person says.
- One repository per deployment, not per organisation.

## More

- [Upgrade notes](docs/upgrades/), one per release.
- The kit's [plugins section](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#16-plugins)
  and [AI layer](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#9-ai-layer).
