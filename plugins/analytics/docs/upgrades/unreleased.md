---
version: unreleased
previous: 3.8.0
date: null
breaking: false
migrations: []
areas: [api, tests]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`GET /api/analytics/facts/status` reports only the caller's organisation. It used to read `MAX()` across every tenant, so an organisation's admin saw when any other organisation last had activity, and a busy tenant could hide another's stale fact table.

- `services/fact-tables/freshness.ts`: `checkFactTableFreshness(db, tenantId, now?)` filters both the fact table and its source on `tenant_id`.
- `api/routes/analytics-pages.ts`: the route passes `ctx.tenantId`.
- `services/fact-tables/registry.ts`: a fact table's `source.table` must carry `tenant_id`, as the fact table already does.
- `tests/api/`: freshness and the route are each tested against a second organisation's newer activity.
- `rocketflare analytics check-facts` reads the same route, so it now reports the signed-in organisation only.

## How to apply

1. Run `pnpm plugin upgrade analytics --apply`. It replaces the three source files, the two test files and `services/fact-tables/CLAUDE.md`.
2. If app code calls `checkFactTableFreshness` itself, pass the tenant id as the second argument.
3. If the app contributes a fact table through `analyticsExtensions({ factTables })`, check its `source.table` has a `tenant_id` column. Without one, `/facts/status` fails with `column "tenant_id" does not exist`.

## Conflicts to expect

None.

## Verify

1. `pnpm gate` passes, including `tests/api/fact-table-refresh.test.ts` and `tests/api/analytics-pages.test.ts`.
2. As one organisation's admin, `GET /api/analytics/facts/status` reports no lag when only another organisation has unbuilt activity.
