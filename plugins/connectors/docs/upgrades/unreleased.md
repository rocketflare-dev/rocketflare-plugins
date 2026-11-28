---
version: unreleased
previous: 3.15.0
date: null
breaking: false
migrations: []
areas: [api, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Connectors stops for an organisation that turned it off (kit 0.48.0's kill switch), and `pnpm plugin check` no longer warns about it. The plugin needs kit 0.48.0 or later (it declared 0.29.0 before).

- The hourly sync tick (`connectors.enqueueDueSyncs`, `17 * * * *`) is a `perTenantTask`: the kit calls it once per organisation and never for one where an admin turned connectors off in Settings → Domains. Each call reconciles that organisation's active installations and enqueues its due cursors; the `connectors` flag check is unchanged.
- `connectorExtensions` on `@/plugins/connectors` is the shared builder with the provider contract typed, rather than a wrapper function around it. Same name, same signature, so a provider plugin (`m365`) changes nothing.

## How to apply

1. Upgrade the kit to 0.48.0 first.
2. Run `pnpm plugin upgrade connectors --apply`. No migration, no toml change: the cron expression is unchanged.

## Conflicts to expect

- `api/scheduled.ts`, if you changed the tick: `enqueueDueSyncs(ctx, now?)` now takes a `TenantCronCtx` and reads only `ctx.tenantId`'s installations. Keep your change inside it.
- A test of yours that called `enqueueDueSyncs(makeCronCtx(...))` passes `{ ...makeCronCtx(...), tenantId }`.

## Verify

1. `pnpm plugin check` prints no `connectors:` warning.
2. `pnpm test config apps/web/tests/config/units.test.ts` prints no `[units] connectors:` line.
3. `pnpm test api apps/web/src/plugins/connectors` passes, including "enqueues nothing for an organisation that turned connectors off".
