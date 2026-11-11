---
version: unreleased
previous: 3.10.0
date: null
breaking: false
migrations: []
areas: [api]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A re-ranker key saved before any base URL is now cleared when a base URL is first set without the key, as a key already was on any other base-URL change: a key belongs to one endpoint.

- `services/settings.ts` `nextSettings` counts a change from no URL to a URL as a base-URL change.

## How to apply

1. Run `pnpm plugin upgrade global-search --apply`.

## Conflicts to expect

None. The plugin's own files change; the host's barrels do not.

## Verify

1. `pnpm plugin check` reports `global-search` checks out.
2. The plugin's `tests/api/global-search.test.ts` passes, including "a key saved before any URL belongs to no endpoint: choosing one without the key clears it".
