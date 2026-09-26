---
version: unreleased
previous: null
date: null
breaking: false
migrations:
  - "connectors_installations — one row per tenant per provider: status, app mode, sealed BYO secret, external tenant id, granted scopes; RLS policy"
  - "connectors_connections — whose data a cursor reads (the organisation '*', one per mailbox, later one per user), sealed access-token cache; RLS policy"
  - "connectors_sync_cursors — one per (connection, resource): opaque provider cursor, pass generation, DB claim; RLS policy"
  - "connectors_directory_users / connectors_directory_groups / connectors_group_members — the synced directory, cascading from the installation; RLS policies"
  - "connectors_calendar_events — synced events per mailbox, readable by their owner and admins only; RLS policy"
areas: [shared, db, api, ui, cli, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The first release: organisation-level connections to Microsoft 365 / Google Workspace (D34, phase 1 — directory and calendar, org-wide, app-only, delta polling). Provider-neutral: a provider plugin (`m365`) contributes the vendor conversation through `extensions`; this plugin owns every row, route, cursor and schedule.

- Settings → Connections (read `Connector`: owner, admin, support): connect through the provider's admin-consent page, watch per-resource sync progress, "Sync now", disconnect (purges every synced row by cascade). Bring-your-own app credentials are sealed (`sealSecret`) and answered as `hasCredential`.
- My calendar (every member, behind the `connectors` flag): the reader's OWN synced events. Only `manage Connector` may read other people's (`GET /api/connectors/events?scope=all|userId=`).
- Only directory people who are MEMBERS of this organisation (matched by lower-cased email) have their calendar synced; a mailbox that stops qualifying is removed with its events.
- The consent callback is a public mount, `/api/hooks/connectors/:provider/callback`, trusting only a signed state (`signState`) that binds tenant, admin, installation and provider.
- One job, `connectors.sync` (one cursor, up to 10 pages, DB claim row, continuation), and a `*/15 * * * *` cron that reconciles members and enqueues due cursors for tenants with the flag on.
- `rocketflare connectors status | sync [--provider] [--resource]`.

## How to apply

1. Confirm the kit is 0.12.0 or later (public plugin mounts, `signState`/`verifyState`, `ctx.features(tenantId)`).
2. `pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/connectors`, read the plan, re-run with `--apply`; then install a provider (`--subdir plugins/m365`).
3. `pnpm db:generate --name plugin-connectors-<version>` and `pnpm db:migrate`.
4. `pnpm provision cloudflare <env>` so both tomls carry the `*/15 * * * *` cron.
5. Confirm `OAUTH_ENCRYPTION_KEY` is set everywhere: tokens, BYO secrets and the consent state all depend on it.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` reports `connectors` checks out.
2. The generated migration creates the seven `connectors_*` tables with their RLS policies, and nothing else.
3. `pnpm test` passes, including `src/plugins/connectors/tests/**`.
