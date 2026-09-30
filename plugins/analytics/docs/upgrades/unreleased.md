---
version: unreleased
previous: 3.4.1
date: null
breaking: false
migrations: []
areas: [api]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The dashboard-visibility test's setup delete now names the tenant, so an app with analytics installed passes the kit's `unscoped-allowlist` scan.

- `apps/web/src/plugins/analytics/tests/api/dashboard-visibility.test.ts`: the delete that removes a page's last group grant filters on `tenantId` as well as `pageId` (#8).

## How to apply

1. `pnpm plugin upgrade analytics --apply` replaces the test file; nothing else changes.
2. If the app added `src/plugins/analytics/tests/api/dashboard-visibility.test.ts` to `CORE_UNSCOPED_ALLOWLIST` in `apps/web/tests/config/unscoped-allowlist.test.ts` as a workaround, delete that entry: the test fails a stale allow-list entry.

## Conflicts to expect

None.

## Verify

1. `pnpm web test:config` passes, including `tests/config/unscoped-allowlist.test.ts`.
