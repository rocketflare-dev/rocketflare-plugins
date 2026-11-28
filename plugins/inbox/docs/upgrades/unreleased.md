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

Inbox's tools answer `egress` and `readsContent`, so `pnpm plugin check` no longer warns about them, and the plugin needs kit 0.47.0 or later.

- `inbox_list_messages` and `inbox_get_message` read stored mail from this database and are `egress: false`.
- Both are `readsContent: true`, because senders, subjects and bodies are untrusted text from outside.
- `minKit` rises from 0.41.0 to 0.47.0, the kit that added the two fields to `Tool`.
- This is the plugin's first release on its own tag, `inbox-v3.15.0`. Earlier releases shipped with every plugin under one `X.Y.Z` tag, and `3.14.0` remains a valid pin.

## How to apply

1. On a kit older than 0.47.0, upgrade the kit first (`pnpm kit:upgrade`).
2. Run `pnpm plugin upgrade inbox --apply`.

## Conflicts to expect

None: the changed files belong to the plugin.

## Verify

1. `pnpm plugin check --json` reports no `gress:` warning.
