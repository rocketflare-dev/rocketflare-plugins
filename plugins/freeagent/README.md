# freeagent

> Connect each organisation's FreeAgent company (UK accounting) and get its books mirrored into
> your app — for pages, agents, analytics and the plugins you build on top.

An admin approves your FreeAgent app once, over OAuth. Every 30 minutes the plugin syncs the
company's bank accounts, bank transactions, explanations, categories, contacts, bills and invoices
into tenant-scoped `freeagent_*` tables, incrementally. Agents read that mirror and can propose an
explanation or a bill for a person to approve. Other plugins — a receipts matcher, say — explain
transactions and attach receipts through an exported service API, and hear about every sync through
the `freeagent:sync-listeners` extension.

## What it adds

| Area | What you get |
|---|---|
| Connection | One FreeAgent company per organisation. OAuth approval through `POST /api/freeagent/connect` and the public callback `/api/hooks/freeagent/callback` (signed state). Refresh and access tokens stored sealed. A refused refresh token marks the connection **needs reconnecting** |
| Sync | `freeagent.sync`, queued every 30 minutes per connected organisation, after connecting, and by **Sync now**. Incremental by `updated_since`, paged, across every bank account. The first sync reaches back about 400 days for transactions |
| Client | One typed wrapper: always `X-Api-Version: 2026-09-01`, token refresh 2 minutes before expiry (single-flight), bounded back-off on 429 `Retry-After`, `Link` pagination, typed `FreeAgentError`, and the token never sent off the FreeAgent API host |
| UI | **Settings → FreeAgent**: connect, reconnect, disconnect, environment, company, last sync, errors, Sync now. **FreeAgent** page: unexplained transactions and invoices (overdue filter) |
| Agent tools | Read: `freeagent_company`, `freeagent_search_transactions`, `freeagent_list_categories`, `freeagent_list_invoices`, `freeagent_list_bills`. Write, approval required, admin requesters only: `freeagent_explain_transaction`, `freeagent_create_bill`. None offered until the organisation is connected |
| Service API | `freeagentClientFor`, `explainTransaction`, `attachToExplanation`, `deleteExplanation`, `createBill`, `listUnexplainedTransactions` — each write updates the mirror row it touched |
| Extension | `freeagent:sync-listeners`: a plugin contributes `{ id, onSync(summary, ctx) }`, called after every successful sync |
| Analytics | When the `analytics` plugin is installed: cubes `FreeAgentTransactions`, `FreeAgentExplanations` (+ `FreeAgentCategories`), `FreeAgentInvoices`, `FreeAgentBills` — spend and income by month and category, unexplained count and amount, outstanding and overdue. Inert without analytics |
| Data | `freeagent_connections`, `freeagent_sync_state` and seven mirror tables, all with row-level security; money as `numeric` |
| CLI | `rocketflare freeagent status` and `rocketflare freeagent sync` |
| Skill | `/freeagent`: registering the app (sandbox and production), secrets, connecting, verifying, troubleshooting |

## Requirements

- Rocketflare kit **0.21.0** or later.
- A FreeAgent app registered at [dev.freeagent.com](https://dev.freeagent.com) with the redirect
  URI `{APP_URL}/api/hooks/freeagent/callback`.
- `OAUTH_ENCRYPTION_KEY` (the kit's bootstrap sets it) and the kit's `JOBS_QUEUE`.

## Install

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.6.0 --subdir plugins/freeagent
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.6.0 --subdir plugins/freeagent --apply
pnpm db:generate --name plugin-freeagent-<version> && pnpm db:migrate
```

Then set the three keys — `FREEAGENT_CLIENT_ID`, `FREEAGENT_CLIENT_SECRET`, `FREEAGENT_ENVIRONMENT`
(`sandbox` | `production`, unset means `sandbox`) — in `apps/web/.dev.vars` locally and with
`wrangler secret put` deployed. All three are declared as secrets so no toml edit is needed; the
environment is not sensitive and may go under `[vars]` in both tomls instead. `pnpm provision
cloudflare <env>` writes the `*/30 * * * *` cron. Run `/freeagent` for the walk-through.

## Building on it

```ts
import { freeagentExtensions } from '@rocketflare/shared/plugins/freeagent/index'
import {
  attachToExplanation,
  explainTransaction,
  type FreeAgentSyncListener,
  listUnexplainedTransactions,
} from '@/plugins/freeagent'

const rematch: FreeAgentSyncListener = {
  id: 'receipts',
  async onSync(summary, ctx) {
    await ctx.enqueue({ type: 'receipts.match', payload: { tenantId: summary.tenantId } })
  },
}

// in a job:
const open = await listUnexplainedTransactions(ctx, tenantId, { from: '2026-04-06' })
const explanation = await explainTransaction(ctx, tenantId, {
  bankTransactionUrl: open[0].url,
  categoryUrl, // from freeagent_categories
  grossValue: open[0].unexplainedAmount, // signed like the transaction
  datedOn: open[0].datedOn,
  description: 'Train ticket',
})
await attachToExplanation(ctx, tenantId, explanation.url, {
  bytes, filename: 'receipt.pdf', contentType: 'application/pdf',
})

export const receiptsServer = {
  // …
  extensions: freeagentExtensions({ syncListeners: [rematch] }),
}
```

Declare `requires: { plugins: ["freeagent"] }` in your `plugin.json`. Writes throw `FreeAgentError`;
branch on `err.code` (`needs_reconnect`, `rate_limited`, `validation`, …).

## Who sees what

Every member can see the FreeAgent page and the mirrored books, and their agent runs get the read
tools. Owners and admins connect, disconnect and sync, and only their runs are offered the two write
tools — each call still waits for a person to approve it.

## Known gaps

- One FreeAgent company per organisation; no accountancy-practice (multi-client) API.
- Polling only (FreeAgent has no webhooks): changes appear within 30 minutes, or on Sync now.
- The first sync mirrors about 400 days of transactions and explanations; older history is not fetched.
- A deleted contact, bill or invoice stays in the mirror (FreeAgent's `updated_since` does not report deletions). Explanations deleted in FreeAgent are reconciled through their transaction.
- No per-user rate-limit budgeting beyond the bounded 429 back-off; a very large first sync may span several queue retries.
- Disconnecting deletes the mirror as well as the tokens.
