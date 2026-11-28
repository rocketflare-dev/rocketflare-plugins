---
version: unreleased
previous: 3.15.0
date: null
breaking: false
migrations: []
areas: [api, ui, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The sync cron runs hourly, at `18 * * * *`, instead of every 30 minutes (`*/30 * * * *`).

- Every tick reads Postgres for the connected organisations, even when there are none. A tick every 30 minutes kept a Neon compute from ever suspending, which is the expensive part of an idle deployment.
- `:18` falls in the same few minutes as the kit's `16 * * * *` agent sweep and the analytics plugin's `15 * * * *`, so the database wakes once an hour for all of them. The expression is the plugin's own, so no other unit's tasks share its dispatch.
- Nothing depended on the faster tick: each sync is incremental by `updated_since` from its own last run, and access tokens are refreshed on use, not by the cron. Changes in FreeAgent now reach the mirror within the hour, or at once on **Sync now**.
- Settings → FreeAgent, the FreeAgent page, the read tools' freshness note, the README and the `freeagent` skill say "every hour".

## How to apply

1. Run `pnpm plugin upgrade freeagent --apply`. It writes `18 * * * *` into `[triggers] crons` in both `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml` (if it prints a note instead, run `pnpm provision declarations`).
2. The upgrade only adds crons, so delete the `"*/30 * * * *"` line from `[triggers] crons` in BOTH tomls by hand. Left in place it does no harm to the database (no task is registered under it, so no connection opens) but it still wakes the Worker every 30 minutes and logs `no tasks registered for this cron expression`.
3. Deploy, so Cloudflare picks up the new triggers.

## Conflicts to expect

None: the changed files belong to the plugin. The two toml lines are the host's and are the only manual edit.

## Verify

1. `grep -n '18 \* \* \* \*\|\*/30' apps/web/wrangler.toml apps/web/wrangler.staging.toml` shows `18 * * * *` in both files and no `*/30`.
2. `pnpm test config` passes (the toml parity test and the plugin-cron check).
3. Locally, `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=18+*+*+*+*"` logs `freeagent.enqueueSyncs`.
