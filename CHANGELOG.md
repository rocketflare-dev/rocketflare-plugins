# Changelog

Every release of `rocketflare-plugins`, newest first. The porting instructions for each live in
that plugin's own `plugins/<id>/docs/upgrades/<version>.md`; this file is the human index.
`pnpm plugin upgrade <id>` in a host app reads those notes and walks the `previous` chain, so a
release with no note is a permanent gap every copy has to step over.

**One version for the whole repository.** Every plugin here ships at the repository's version and
is tagged `X.Y.Z`, with no per-plugin prefix — so "which analytics do I have" and "which kit
release was it proved against" have one answer each.

## 2.0.1 — 2026-09-18

**2.0.0 could not be installed with a green gate**: its anchor still said `1.0.2`, so every install
reported a version mismatch against the recorded surface and exited 1, taking the whole host gate
down with it.
[Porting note](plugins/analytics/docs/upgrades/2.0.1.md).

## 2.0.0 — 2026-09-18

**This plugin is written against the kit's plugin API now**: it declares `requires.pluginApi: "1"`,
which moves it from *warned* to *checked*, and its floor moves to kit `>=0.7.0`, the release that
introduced the contract.
[Porting note](plugins/analytics/docs/upgrades/2.0.0.md).

## Before this repository existed

`analytics` was released from `rocketflare-dev/rocketflare-plugin-analytics` as **1.0.0**, **1.0.1**
and **1.0.2**. Those tags are still there and still installable; anyone pinned to one is
undisturbed. This repository starts at 1.0.2 — the same code, at a new address — and continues
the numbering from there.

| Release | What it was |
|---|---|
| 1.0.2 | The floor moves to kit 0.6.1, because 0.6.0 could never host this plugin with a green gate. [Note](plugins/analytics/docs/upgrades/1.0.2.md) |
| 1.0.1 | Installing this plugin no longer leaves the host unable to build: it declares the two `apps/web/vite.config.ts` lines it needs as `coreEdits[]`, which kit 0.6.1 applies on install and reverts on removal. [Note](plugins/analytics/docs/upgrades/1.0.1.md) |
| 1.0.0 | The first release: analytics as a plugin — dashboards, four tenant-scoped cubes, one fact table, three UI routes and three CLI commands, all of it the Rocketflare kit's §8 up to 0.5.0. [Note](plugins/analytics/docs/upgrades/1.0.0.md) |
