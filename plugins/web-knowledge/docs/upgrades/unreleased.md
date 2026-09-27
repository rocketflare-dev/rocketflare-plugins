---
version: unreleased
previous: 3.3.0
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

No change to web-knowledge: this release exists because `analytics` was made to work with both database drivers the kit may run, and every plugin here ships at the repository's version.

- Audited for the kit 0.15.0 driver switch (postgres.js to the Neon serverless driver, which changes what `db.execute()` returns): web-knowledge makes no raw `execute` call and reads no driver result shape, so it needs no change and works on both.
- Version stamps only (`rocketflare-plugin.json` and its anchor copy); no code, schema or behaviour change.

## How to apply

1. Run `pnpm plugin upgrade web-knowledge --apply`; it changes only the version stamps.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` reports `web-knowledge` checks out at the new version.
