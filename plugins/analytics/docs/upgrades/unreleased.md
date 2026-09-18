---
version: unreleased
previous: 2.0.0
date: null
breaking: false
requires_kit: ">=0.7.0 <1.0.0"
migrations: []
areas: [config]
touches_surfaces: []
requires_surfaces: []
touches_registries: []
manual: false
---

## What changed

**2.0.0 could not be installed with a green gate.** Its anchor —
`apps/web/src/plugins/analytics/plugin.json`, the file copied into a host and the one
`pnpm plugin check` compares against the recorded surface — still said `1.0.2`, so every install
reported `plugin.json says 1.0.2, and the surface says 2.0.0` and exited 1. That is a FAILURE
rather than a warning, so it took the whole host gate down with it.

Nothing about what analytics does changed. This is the version stamp and nothing else.

The cause is worth stating, because it was invisible for three releases. A plugin carries its
version TWICE: in `rocketflare-plugin.json`, the release manifest read from this repository, and in
the anchor, which is what actually reaches a host. `release.mjs` only ever stamped the manifest —
the anchor was kept in step BY HAND, and nothing said so. While each plugin was its own repository
that habit held; moving analytics into a monorepo dropped it, and the next release surfaced it.

Kit 0.7.0's `release.mjs` now stamps every manifest's declared anchor, so this cannot recur, and
this release was cut with that fix rather than hand-patched — which is what proves it.

## How to apply

`pnpm plugin upgrade analytics` if you are on 2.0.0. Nothing else: no migration, no schema change,
no code change.

If you installed 2.0.0 you will have seen `pnpm plugin check` fail on the version mismatch. There is
nothing to undo — the anchor is data, and 2.0.1 corrects it.

## Conflicts to expect

None. One version string in one file.

## Verify

```bash
pnpm plugin check   # exits 0, with no version mismatch for analytics
```

