# Changelog

Every release of `rocketflare-plugins`, newest first. The porting instructions for each live in
that plugin's own `plugins/<id>/docs/upgrades/<version>.md`; this file is the human index.
`pnpm plugin upgrade <id>` in a host app reads those notes and walks the `previous` chain, so a
release with no note is a permanent gap every copy has to step over.

**One version for the whole repository.** Every plugin here ships at the repository's version and
is tagged `X.Y.Z`, with no per-plugin prefix — so "which analytics do I have" and "which kit
release was it proved against" have one answer each.

## 3.4.0 — 2026-09-27

**analytics** — Analytics now reads raw `db.execute()` results in a driver-neutral way, so it works on the kit's current postgres.js driver and on the Neon serverless driver the kit moves to in 0.15.0.
[Porting note](plugins/analytics/docs/upgrades/3.4.0.md).

**web-knowledge** — No change to web-knowledge: this release exists because `analytics` was made to work with both database drivers the kit may run, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.4.0.md).

**connectors** — No change to connectors: this release exists because `analytics` was made to work with both database drivers the kit may run, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.4.0.md).

**m365** — No change to m365: this release exists because `analytics` was made to work with both database drivers the kit may run, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.4.0.md).

## 3.3.0 — 2026-09-27

**analytics** — Analytics now ships four Claude Code skills for drizzle-cube: `analytics`, `analytics-cubes`, `analytics-queries` and `analytics-dashboards`.
[Porting note](plugins/analytics/docs/upgrades/3.3.0.md).

**web-knowledge** — No change to web-knowledge: this release exists because the repository added skills to `connectors` and `analytics`, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.3.0.md).

**connectors** — Connectors now ships a `connectors` Claude Code skill that drives Microsoft 365 setup end to end, and Settings → Connections shows each audience only the steps it can act on.
[Porting note](plugins/connectors/docs/upgrades/3.3.0.md).

**m365** — No change to m365: this release exists because the repository added skills to `connectors` and `analytics`, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.3.0.md).

## 3.2.0 — 2026-09-26

**analytics** — No change to analytics: this release exists because the repository released `connectors` and `m365` and every plugin here ships at the repository's version.
[Porting note](plugins/analytics/docs/upgrades/3.2.0.md).

**web-knowledge** — No change to web-knowledge: this release exists because the repository released `connectors` and `m365` and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.2.0.md).

**connectors** — The first release: organisation-level connections to Microsoft 365 / Google Workspace (D34, phase 1 — directory and calendar, org-wide, app-only, delta polling). Provider-neutral: a provider plugin (`m365`) contributes the vendor conversation through `extensions`; this plugin owns every row, route, cursor and schedule.
[Porting note](plugins/connectors/docs/upgrades/3.2.0.md).

**m365** — The first release: Microsoft 365 as a `connectors` provider (D34, phase 1). An organisation admin grants the deployment's multi-tenant Entra app admin consent once; the directory (`users/delta`, `groups/delta` with memberships) and the Outlook calendars of people who are members of this app (`calendarView/delta` over a rolling −30…+90 day window) then sync every 15 minutes, app-only.
[Porting note](plugins/m365/docs/upgrades/3.2.0.md).

## 3.1.0 — 2026-09-18

**analytics** — No change to analytics: this release exists because the repository released `web-knowledge` and every plugin here ships at the repository's version.
[Porting note](plugins/analytics/docs/upgrades/3.1.0.md).

**web-knowledge** — The first release: web search for agents and chat on each organisation's own key (Tavily, Brave, Exa, Serper or Firecrawl), configured in Settings → Web search and offered only to tenants that turn it on.
[Porting note](plugins/web-knowledge/docs/upgrades/3.1.0.md).

## 3.0.0 — 2026-09-18

**Compatibility is observed now, not declared**: `requires.kit` and `requires.pluginApi` are gone, replaced by a top-level `minKit` of `0.8.0` and a derived `uses` block, so this release installs only into kit 0.8.0 or later.
[Porting note](plugins/analytics/docs/upgrades/3.0.0.md).

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
