---
version: unreleased
previous: 3.8.2
date: null
breaking: true
migrations: []
areas: [api, cli]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

FreeAgent write tools now follow the requester's `manage` permission, and the OAuth callback re-reads the admin who started it.

- The two write tools are offered on `ctx.can('manage', FREEAGENT_SUBJECT)`: they reach an admin's agent runs under their approval gate, and not chat.
- The OAuth callback calls `memberCan` after `verifyState`; on `false` it redirects with `connectError=approval_failed` and saves nothing.
- CLI status and sync lines neutralise server text.

## How to apply

1. Install on kit 0.29.0 or later, which carries the plugin entries this version imports.
2. Move any workflow that used a FreeAgent write tool from chat to an agent run.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` passes.
