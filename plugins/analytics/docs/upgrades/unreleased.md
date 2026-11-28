---
version: unreleased
previous: 3.14.0
date: null
breaking: false
migrations: []
areas: [api]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Analytics' cube tools answer `egress` and `readsContent`, so `pnpm plugin check` no longer warns about them, and the plugin needs kit 0.47.0 or later.

- `analytics_discover`, `analytics_validate` and `analytics_load` are `egress: false`: they query this database through the cubes.
- `analytics_load` is `readsContent: true` because it returns rows. `analytics_discover` and `analytics_validate` are `readsContent: false` because they return only cube definitions and the query itself (`CUBE_TOOLS` in `tools/cube-tools.ts`).
- `minKit` rises from 0.41.0 to 0.47.0, the kit that added the two fields to `Tool`.
- This is the plugin's first release on its own tag, `analytics-v3.15.0`. Earlier releases shipped with every plugin under one `X.Y.Z` tag, and `3.14.0` remains a valid pin.

## How to apply

1. On a kit older than 0.47.0, upgrade the kit first (`pnpm kit:upgrade`).
2. Run `pnpm plugin upgrade analytics --apply`.

## Conflicts to expect

None: the changed files belong to the plugin.

## Verify

1. `pnpm plugin check --json` reports no `gress:` warning.
