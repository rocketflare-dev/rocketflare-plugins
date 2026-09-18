# Changelog

Every release of `rocketflare-plugins`, newest first. The porting instructions for each live in
that plugin's own `plugins/<id>/docs/upgrades/<version>.md`; this file is the human index.
`pnpm plugin upgrade <id>` in a host app reads those notes and walks the `previous` chain, so a
release with no note is a permanent gap every copy has to step over.

**One version for the whole repository.** Every plugin here ships at the repository's version and
is tagged `X.Y.Z`, with no per-plugin prefix — so "which analytics do I have" and "which kit
release was it proved against" have one answer each.

## Before this repository existed

`analytics` was released from `rocketflare-dev/rocketflare-plugin-analytics` as **1.0.0**, **1.0.1**
and **1.0.2**. Those tags are still there and still installable; anyone pinned to one is
undisturbed. This repository starts at 1.0.2 — the same code, at a new address — and continues the
numbering from there.

| Release | What it was |
|---|---|
| 1.0.2 | The floor moved to kit 0.6.1, because 0.6.0 could never host the plugin with a green gate. [Note](plugins/analytics/docs/upgrades/1.0.2.md) |
| 1.0.1 | Installing the plugin no longer left the host unable to build. [Note](plugins/analytics/docs/upgrades/1.0.1.md) |
| 1.0.0 | The first release: analytics as a plugin — dashboards, four tenant-scoped cubes, one fact table, three UI routes, three CLI commands. [Note](plugins/analytics/docs/upgrades/1.0.0.md) |
