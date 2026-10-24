---
name: freeagent
description: Set up, connect, verify and troubleshoot the `freeagent` plugin — registering a FreeAgent app at dev.freeagent.com (sandbox and production), the redirect URI, setting FREEAGENT_CLIENT_ID / FREEAGENT_CLIENT_SECRET / FREEAGENT_ENVIRONMENT locally and deployed, connecting an organisation's FreeAgent company, checking the sync, and decoding errors such as needs reconnecting, rate limited, invalid redirect URI or an empty mirror. Use when someone asks to connect FreeAgent, set up UK accounting/bookkeeping integration, sync bank transactions or invoices from FreeAgent, or asks why FreeAgent stopped syncing.
argument-hint: "[explain | register | secrets | connect | verify | troubleshoot]"
---

# /freeagent — FreeAgent, set up end to end

The `freeagent` plugin connects ONE FreeAgent company per organisation over OAuth, mirrors its
bank accounts, transactions, explanations, categories, contacts, bills and invoices into
`freeagent_*` tables every 30 minutes, gives agents read tools (and two approval-gated write
tools), and exports a service API other plugins (a receipts matcher) build on. Code rules:
`apps/web/src/plugins/freeagent/CLAUDE.md`.

`$ARGUMENTS` picks the mode. With none: run **Status**, then ask which mode they need.

## Rules

- Anything at dev.freeagent.com or in FreeAgent itself is the user's to click. Give the exact path;
  never claim you did it.
- **Never** echo, log or paste a client secret, an access token, a refresh token or an approval
  code. Secrets go in through stdin (`wrangler secret put`) or `apps/web/.dev.vars`, never a toml,
  never a commit, never a chat transcript.
- Sandbox first. A sandbox app and a production app are separate registrations with separate
  credentials; tokens from one never work against the other.

## Status

1. `pnpm cli freeagent status` — configured?, environment, connection, company, last sync, last
   error, mirrored counts.
2. Deployed: `pnpm --filter @rocketflare/web exec wrangler tail` during a sync. Lines that matter:
   `freeagent.sync failed` (with a `code`), `freeagent.sync: the connection needs an admin to
   reconnect`, `freeagent: completing the connection failed` (with a `code`),
   `freeagent.enqueueSyncs` (how many tenants the cron queued).

## Mode: explain

In this order: the deployment registers one FreeAgent app; an admin of each organisation clicks
**Connect FreeAgent** in Settings → FreeAgent and approves it in FreeAgent; FreeAgent redirects to
`{APP_URL}/api/hooks/freeagent/callback`, which stores the tokens sealed and queues the first sync;
every 30 minutes the cron queues `freeagent.sync` per connected organisation; the sync is
incremental (`updated_since`), and the first one reaches back about 400 days for transactions;
agents read the mirror and may propose an explanation or a bill, which a person approves.

## Mode: register

1. Sign in at **https://dev.freeagent.com** → **My Apps** → **Create New App**.
2. Name it after the app (e.g. "GuideMode"). **OAuth redirect URIs**: add exactly
   `{APP_URL}/api/hooks/freeagent/callback` for every origin that will connect — e.g.
   `http://localhost:3001/api/hooks/freeagent/callback` for local dev (the Worker's port, not
   Vite's), `https://staging.example.com/api/hooks/freeagent/callback`,
   `https://app.example.com/api/hooks/freeagent/callback`. The match is exact: scheme, host, port
   and path.
3. Copy the **OAuth identifier** (client id) and **OAuth secret** (client secret). They are the
   same for sandbox and production API hosts only if FreeAgent says so — treat the sandbox
   registration as its own app.
4. **Sandbox**: create a sandbox company at **https://signup.sandbox.freeagent.com** (it is a
   separate FreeAgent login), and add some bank transactions there to have something to sync.
   Production: the real company's FreeAgent login approves the app at connect time.

## Mode: secrets

The plugin reads three keys (all declared as secrets so no toml edit is needed):

| Key | Value |
|---|---|
| `FREEAGENT_CLIENT_ID` | the OAuth identifier |
| `FREEAGENT_CLIENT_SECRET` | the OAuth secret |
| `FREEAGENT_ENVIRONMENT` | `sandbox` or `production` (unset = `sandbox`). Not sensitive: a host may instead put it under `[vars]` in BOTH tomls |

**Locally**: add to `apps/web/.dev.vars` (git-ignored) — the user types the values, or you write
the keys and they fill in the values:

```
FREEAGENT_CLIENT_ID=
FREEAGENT_CLIENT_SECRET=
FREEAGENT_ENVIRONMENT=sandbox
```

Also add the three keys with empty values to `apps/web/.dev.vars.example`. Restart `pnpm dev`.
`OAUTH_ENCRYPTION_KEY` must be set too (the kit's bootstrap writes it) — tokens are sealed with it.

**Deployed** (per environment, values from stdin so they never reach shell history):

```bash
pnpm --filter @rocketflare/web exec wrangler secret put FREEAGENT_CLIENT_ID          # paste, Enter
pnpm --filter @rocketflare/web exec wrangler secret put FREEAGENT_CLIENT_SECRET
printf production | pnpm --filter @rocketflare/web exec wrangler secret put FREEAGENT_ENVIRONMENT
# staging: add  --config wrangler.staging.toml  to each
```

Or `pnpm provision secrets <env>`, which reads them from the shell or `apps/web/.provision.env`.
The `*/30 * * * *` cron is written into both tomls by `pnpm provision cloudflare <env>`.

## Mode: connect

1. Signed in as an owner or admin: **Settings → FreeAgent**. The Environment badge must say what
   you expect; if the panel says the deployment has no FreeAgent app, do **secrets** first.
2. **Connect FreeAgent** → FreeAgent's sign-in → approve. FreeAgent sends the browser back to
   Settings with "FreeAgent connected. The first sync has started."
3. A **Reconnect** to a different FreeAgent company clears the old mirror first, so two companies'
   books are never mixed.

## Mode: verify

1. `pnpm cli freeagent status` — `Connection: connected`, the company name, and within a minute or
   two a `Last sync` time and non-zero counts.
2. The **FreeAgent** page lists unexplained transactions and recent invoices.
3. `pnpm cli freeagent sync` queues another sync; the last-sync time moves.
4. In chat, ask "what's unexplained in FreeAgent this month?" — the agent should call
   `freeagent_search_transactions`.

## Mode: troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| FreeAgent shows "redirect_uri mismatch" / invalid redirect | the callback URL is not registered exactly | add `{APP_URL}/api/hooks/freeagent/callback` (right scheme, host, port) in the app at dev.freeagent.com |
| Callback answers 401 "Invalid or expired FreeAgent approval" | the approval took over 15 minutes, or the link was reused | click Connect again |
| Toast "Completing the connection … failed" | wrong secret, sandbox credentials against production (or vice versa) | check the three keys match ONE registration and environment |
| Status "needs reconnecting" | FreeAgent refused the refresh token (`invalid_grant`): the approval was revoked in FreeAgent, or the environment changed | an admin clicks Reconnect |
| `Last error: FreeAgent rate limit reached` | 120 requests/min or 3600/hour per user | nothing; the queue retries with backoff. A big first sync may take a few runs |
| Connected but no transactions | the first sync looks back ~400 days; older history is not mirrored, or the sandbox company is empty | add transactions in FreeAgent and Sync now |
| Settings warns the connection was made in another environment | `FREEAGENT_ENVIRONMENT` changed after connecting | Reconnect |
| Write tools never offered | the requester is not an admin, or the organisation is not connected | by design; members get read tools only |

Testing back-off by hand (sandbox only): FreeAgent lowers the limit to 5 requests a minute when a
request carries `X-RateLimit-Test: true`. The plugin never sends it; use curl against the sandbox
with a token if you need to see a 429.
