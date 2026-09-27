---
version: unreleased
previous: 3.4.0
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

No change to web-knowledge: this release exists because `analytics` needed a type fix to compile against kit 0.15.0's driver-neutral `Database`, and every plugin here ships at the repository's version.

- Audited against kit 0.15.0 (two database drivers, D35): web-knowledge makes no raw `db.execute()` read and hands the handle to no library that types it by driver, so it compiles and runs unchanged on both.
- Version stamps only (`rocketflare-plugin.json` and its anchor copy); no code, schema or behaviour change.

## How to apply

1. Run `pnpm plugin upgrade web-knowledge --apply`; it changes only the version stamps.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` reports `web-knowledge` checks out at the new version.
