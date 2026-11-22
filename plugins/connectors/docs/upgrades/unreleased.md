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

The connectors API test shares the host's `api` module registry: it drops a `// @vitest-isolate` marker it did not need.

- `tests/api/connectors.test.ts` swaps the provider registry with `setConnectorProvidersForTests` and puts it back in `afterAll`, so nothing leaks to a file that runs after it in the same worker.

## How to apply

1. Take this release's `apps/web/src/plugins/connectors/tests/api/connectors.test.ts` (`pnpm plugin upgrade connectors` does it).

## Conflicts to expect

- `tests/api/connectors.test.ts` → only if you edited it → keep your edits and delete the first line, `// @vitest-isolate`.

## Verify

1. `pnpm test api apps/web/src/plugins/connectors` passes, and lists the file under `api`, not `api-isolated`.
