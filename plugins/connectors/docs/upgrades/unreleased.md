---
version: unreleased
previous: 3.14.0
date: null
breaking: false
migrations: []
areas: [api, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The sync cron runs hourly, at `17 * * * *`, instead of every 15 minutes (`*/15 * * * *`).

- Every tick reads Postgres, even when nothing is installed. A tick every 15 minutes kept a Neon compute from ever suspending, which is the expensive part of an idle deployment.
- `:17` falls in the same few minutes as the kit's `16 * * * *` agent sweep and the analytics plugin's `15 * * * *`, so the database wakes once an hour for all three. The expression is the plugin's own, so no other unit's tasks share its dispatch.
- A cursor is due again 45 minutes after its last sync, down from 15, so a cursor the previous tick synced is always due on the next one. A cursor synced by **Sync now** in the last 45 minutes waits for the tick after.
- A pass that stopped mid-way still resumes on the next tick, which can now be up to an hour away. **Sync now** and `pnpm cli connectors sync` still sync at once.
- The README, the `connectors` skill and the code comments say "hourly".

## How to apply

1. Run `pnpm plugin upgrade connectors --apply`. It writes `17 * * * *` into `[triggers] crons` in both `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml` (if it prints a note instead, run `pnpm provision declarations`).
2. The upgrade only adds crons, so delete the `"*/15 * * * *"` line from `[triggers] crons` in BOTH tomls by hand. Left in place it does no harm to the database (no task is registered under it, so no connection opens) but it still wakes the Worker every 15 minutes and logs `no tasks registered for this cron expression`.
3. Deploy, so Cloudflare picks up the new triggers.

## Conflicts to expect

None: the changed files belong to the plugin. The two toml lines are the host's and are the only manual edit.

## Verify

1. `grep -n '17 \* \* \* \*\|\*/15' apps/web/wrangler.toml apps/web/wrangler.staging.toml` shows `17 * * * *` in both files and no `*/15`.
2. `pnpm test config` passes (the toml parity test and the plugin-cron check).
3. Locally, `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=17+*+*+*+*"` logs `connectors.enqueueDueSyncs`.
