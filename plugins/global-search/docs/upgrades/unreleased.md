---
version: unreleased
previous: 3.13.2
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The plugin's API tests pass in a host where another installed plugin also registers search
providers, such as `guide`.

- `tests/api/global-search.test.ts` checks the provider list for its members, not its exact contents.
- The API test of the foreign-namespace refusal is gone: `tests/config/search-core.test.ts` covers the rule on `buildRegistry`. The invalid-registration test now checks only that the route fails.

## How to apply

1. Replace `apps/web/src/plugins/global-search/tests/api/global-search.test.ts` with this release's file (`pnpm plugin upgrade global-search` does it).

## Conflicts to expect

- `tests/api/global-search.test.ts` → only if you edited it → keep your own tests and take the provider-list assertion from this release.

## Verify

1. With `guide` installed, `pnpm --filter @<slug>/web exec dotenv -e .env.test -- vitest run --project api-isolated src/plugins/global-search` passes.
