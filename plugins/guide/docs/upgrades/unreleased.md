---
version: unreleased
previous: 3.13.1
date: null
breaking: false
migrations: []
areas: [config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The guide manifest now carries a one-line `description`, which the kit's `pnpm plugin list --available` prints in place of the README's opening line.

- `rocketflare-plugin.json` and its anchor copy `apps/web/src/plugins/guide/plugin.json` gain `"description"`, a sentence saying what the plugin gives an app. Metadata only; no code, schema or behaviour change.

## How to apply

1. Run `pnpm plugin upgrade guide --apply`; it adds the `description` line to the anchor manifest.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` passes.
