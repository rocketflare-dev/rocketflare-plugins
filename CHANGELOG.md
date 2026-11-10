# Changelog

Every release of `rocketflare-plugins`, newest first. The porting instructions for each live in
that plugin's own `plugins/<id>/docs/upgrades/<version>.md`; this file is the human index.
`pnpm plugin upgrade <id>` in a host app reads those notes and walks the `previous` chain, so a
release with no note is a permanent gap every copy has to step over.

**One version for the whole repository.** Every plugin here ships at the repository's version and
is tagged `X.Y.Z`, with no per-plugin prefix — so "which analytics do I have" and "which kit
release was it proved against" have one answer each.

## 3.10.1 — 2026-11-10

Ask the Guide no longer shows raw footnote marks such as `[^2]` or an empty bullet at the end of an answer, and finds the citations block however the model formats its header.
[Porting note](plugins/guide/docs/upgrades/3.10.1.md).

## 3.10.0 — 2026-11-10

**guide** — First release of `guide`: an in-app user guide about the app itself, written by the developer's coding agent and kept in sync with the code by a Claude Code Stop hook.
[Porting note](plugins/guide/docs/upgrades/3.10.0.md).

**global-search** — First release of `global-search`: a ⌘K palette in the header and a `/search/all` page over every registered search provider, fused with RRF and optionally re-ranked per organisation.
[Porting note](plugins/global-search/docs/upgrades/3.10.0.md).

## 3.9.0 — 2026-11-09

**analytics** — Analytics limits the activity cube to admins, caps batch size, sets a statement timeout and stops recording a creator on template pages.
[Porting note](plugins/analytics/docs/upgrades/3.9.0.md).

**connectors** — A connection now requires provider-authenticated proof of the external organisation, and one external organisation backs one workspace.
[Porting note](plugins/connectors/docs/upgrades/3.9.0.md).

**freeagent** — FreeAgent write tools now follow the requester's `manage` permission, and the OAuth callback re-reads the admin who started it.
[Porting note](plugins/freeagent/docs/upgrades/3.9.0.md).

**inbox** — Inbox tightens which senders it accepts, bounds how far one delivery can split, and holds released addresses for 90 days.
[Porting note](plugins/inbox/docs/upgrades/3.9.0.md).

**issue-reports** — Filed issues now carry a per-organisation marker that search, lookup and comment enforce, and the review page shows what goes to GitHub.
[Porting note](plugins/issue-reports/docs/upgrades/3.9.0.md).

**m365** — Microsoft 365 consent now completes only on a verified sign-in by an administrator of the claimed tenant.
[Porting note](plugins/m365/docs/upgrades/3.9.0.md).

**web-knowledge** — `fetch_page` now reads only URLs `web_search` returned in the same turn or run, and page text extraction is a bounded linear scan.
[Porting note](plugins/web-knowledge/docs/upgrades/3.9.0.md).

## 3.8.2 — 2026-11-08

**analytics** — The analytics UI guide now says fact-table freshness is requested by admins only; no code changed.
[Porting note](plugins/analytics/docs/upgrades/3.8.2.md).

**connectors** — No change to connectors. This release exists because `freeagent` typechecks on kit 0.25.0 and later again, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.8.2.md).

**freeagent** — freeagent typechecks on kit 0.25.0 and later again: its two schema-parsing helpers named zod 3's `z.ZodTypeDef`, which zod 4 (the kit's from 0.25.0) does not have.
[Porting note](plugins/freeagent/docs/upgrades/3.8.2.md).

**inbox** — No change to inbox. This release exists because `freeagent` typechecks on kit 0.25.0 and later again, and every plugin here ships at the repository's version.
[Porting note](plugins/inbox/docs/upgrades/3.8.2.md).

**issue-reports** — No change to issue-reports. This release exists because `freeagent` typechecks on kit 0.25.0 and later again, and every plugin here ships at the repository's version.
[Porting note](plugins/issue-reports/docs/upgrades/3.8.2.md).

**m365** — No change to m365. This release exists because `freeagent` typechecks on kit 0.25.0 and later again, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.8.2.md).

**web-knowledge** — No change to web-knowledge. This release exists because `freeagent` typechecks on kit 0.25.0 and later again, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.8.2.md).

## 3.8.1 — 2026-11-03

**analytics** — `GET /api/analytics/facts/status` reports only the caller's organisation. It used to read `MAX()` across every tenant, so an organisation's admin saw when any other organisation last had activity, and a busy tenant could hide another's stale fact table.
[Porting note](plugins/analytics/docs/upgrades/3.8.1.md).

**connectors** — No change to connectors. This release exists because `analytics` scopes `GET /api/analytics/facts/status` to the caller's organisation, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.8.1.md).

**freeagent** — No change to freeagent. This release exists because `analytics` scopes `GET /api/analytics/facts/status` to the caller's organisation, and every plugin here ships at the repository's version.
[Porting note](plugins/freeagent/docs/upgrades/3.8.1.md).

**inbox** — No change to inbox. This release exists because `analytics` scopes `GET /api/analytics/facts/status` to the caller's organisation, and every plugin here ships at the repository's version.
[Porting note](plugins/inbox/docs/upgrades/3.8.1.md).

**issue-reports** — No change to issue-reports. This release exists because `analytics` scopes `GET /api/analytics/facts/status` to the caller's organisation, and every plugin here ships at the repository's version.
[Porting note](plugins/issue-reports/docs/upgrades/3.8.1.md).

**m365** — No change to m365. This release exists because `analytics` scopes `GET /api/analytics/facts/status` to the caller's organisation, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.8.1.md).

**web-knowledge** — No change to web-knowledge. This release exists because `analytics` scopes `GET /api/analytics/facts/status` to the caller's organisation, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.8.1.md).

## 3.8.0 — 2026-11-03

**analytics** — analytics now compiles on React 19 with React Router 7 as well as on React 18 with Router 6, so a host can move to either. Imports stay on `react-router-dom`. drizzle-cube moves from 0.8.3 to 0.12.2, which declares React 19 and fixes a stored XSS in markdown portlets (GHSA-g3qv-p2w6-c95h).
[Porting note](plugins/analytics/docs/upgrades/3.8.0.md).

**connectors** — No change to connectors. This release exists because `analytics` moves to drizzle-cube 0.12.2 and compiles on React 19 with React Router 7, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.8.0.md).

**freeagent** — No change to freeagent. This release exists because `analytics` moves to drizzle-cube 0.12.2 and compiles on React 19 with React Router 7, and every plugin here ships at the repository's version.
[Porting note](plugins/freeagent/docs/upgrades/3.8.0.md).

**inbox** — No change to inbox. This release exists because `analytics` moves to drizzle-cube 0.12.2 and compiles on React 19 with React Router 7, and every plugin here ships at the repository's version.
[Porting note](plugins/inbox/docs/upgrades/3.8.0.md).

**issue-reports** — No change to issue-reports. This release exists because `analytics` moves to drizzle-cube 0.12.2 and compiles on React 19 with React Router 7, and every plugin here ships at the repository's version.
[Porting note](plugins/issue-reports/docs/upgrades/3.8.0.md).

**m365** — No change to m365. This release exists because `analytics` moves to drizzle-cube 0.12.2 and compiles on React 19 with React Router 7, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.8.0.md).

**web-knowledge** — No change to web-knowledge. This release exists because `analytics` moves to drizzle-cube 0.12.2 and compiles on React 19 with React Router 7, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.8.0.md).

## 3.7.0 — 2026-10-24

**analytics** — No change to analytics. This release exists because `inbox` splits forwarded-as-attachment email into messages of their own, and every plugin here ships at the repository's version.
[Porting note](plugins/analytics/docs/upgrades/3.7.0.md).

**connectors** — No change to connectors. This release exists because `inbox` splits forwarded-as-attachment email into messages of their own, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.7.0.md).

**freeagent** — No code change to freeagent. The duplicated `docs/plugins/freeagent/upgrades/` copy inside the plugin directory, left there by `pnpm plugin export` in 3.6.0, is removed.
[Porting note](plugins/freeagent/docs/upgrades/3.7.0.md).

**inbox** — Forwarded-as-attachment email is split: each embedded `message/rfc822` part becomes an inbox message of its own, so consumers and the knowledge base see one message per forwarded email instead of an `.eml` attachment they skip.
[Porting note](plugins/inbox/docs/upgrades/3.7.0.md).

**issue-reports** — No change to issue-reports. This release exists because `inbox` splits forwarded-as-attachment email into messages of their own, and every plugin here ships at the repository's version.
[Porting note](plugins/issue-reports/docs/upgrades/3.7.0.md).

**m365** — No change to m365. This release exists because `inbox` splits forwarded-as-attachment email into messages of their own, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.7.0.md).

**web-knowledge** — No change to web-knowledge. This release exists because `inbox` splits forwarded-as-attachment email into messages of their own, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.7.0.md).

## 3.6.0 — 2026-10-24

**analytics** — No change to analytics: this release exists because `inbox` and `freeagent` ship for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/analytics/docs/upgrades/3.6.0.md).

**connectors** — No change to connectors: this release exists because `inbox` and `freeagent` ship for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.6.0.md).

**freeagent** — First release of `freeagent`: an organisation connects its FreeAgent company over OAuth, and its books are mirrored every 30 minutes for pages, agents, analytics and other plugins.
[Porting note](plugins/freeagent/docs/upgrades/3.6.0.md).

**inbox** — First release of `inbox`: organisations receive forwarded email through Cloudflare Email Routing, with an allow-list, authentication checks, parsed attachments, forwarding-confirmation codes and a consumer extension for other plugins.
[Porting note](plugins/inbox/docs/upgrades/3.6.0.md).

**issue-reports** — No change to issue-reports: this release exists because `inbox` and `freeagent` ship for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/issue-reports/docs/upgrades/3.6.0.md).

**m365** — No change to m365: this release exists because `inbox` and `freeagent` ship for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.6.0.md).

**web-knowledge** — No change to web-knowledge: this release exists because `inbox` and `freeagent` ship for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.6.0.md).

## 3.5.1 — 2026-10-22

**analytics** — `minKit` rises from 0.13.0 to 0.17.1, because before kit 0.17.1 `plugin check` compares dependency ranges as strings and fails analytics as soon as `react-grid-layout` or `react-is` publishes a newer release inside the declared range.
[Porting note](plugins/analytics/docs/upgrades/3.5.1.md).

**connectors** — No change to connectors: this release exists because `analytics` raised its `minKit` to 0.17.1, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.5.1.md).

**issue-reports** — No change to issue-reports: this release exists because `analytics` raised its `minKit` to 0.17.1, and every plugin here ships at the repository's version.
[Porting note](plugins/issue-reports/docs/upgrades/3.5.1.md).

**m365** — No change to m365: this release exists because `analytics` raised its `minKit` to 0.17.1, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.5.1.md).

**web-knowledge** — No change to web-knowledge: this release exists because `analytics` raised its `minKit` to 0.17.1, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.5.1.md).

## 3.5.0 — 2026-10-22

**analytics** — No change to analytics: this release exists because `issue-reports` ships for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/analytics/docs/upgrades/3.5.0.md).

**connectors** — No change to connectors: this release exists because `issue-reports` ships for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.5.0.md).

**issue-reports** — The first release: Ideas & issues, where anyone on the team talks a bug or an idea through with an agent that asks until it is clear, checks for an existing issue, and logs it on GitHub once they approve the draft.
Contributed by [Mosaic Data](https://mosaicdata.ai/) ([#11](https://github.com/rocketflare-dev/rocketflare-plugins/pull/11)).
[Porting note](plugins/issue-reports/docs/upgrades/3.5.0.md).

**m365** — No change to m365: this release exists because `issue-reports` ships for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.5.0.md).

**web-knowledge** — No change to web-knowledge: this release exists because `issue-reports` ships for the first time, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.5.0.md).

## 3.4.2 — 2026-09-30

**analytics** — The dashboard-visibility test's setup delete now names the tenant, so an app with analytics installed passes the kit's `unscoped-allowlist` scan.
[Porting note](plugins/analytics/docs/upgrades/3.4.2.md).

**connectors** — No change to connectors: this release exists because `analytics` fixed a test that failed the kit's tenant-isolation scan, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.4.2.md).

**m365** — No change to m365: this release exists because `analytics` fixed a test that failed the kit's tenant-isolation scan, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.4.2.md).

**web-knowledge** — No change to web-knowledge: this release exists because `analytics` fixed a test that failed the kit's tenant-isolation scan, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.4.2.md).

## 3.4.1 — 2026-09-27

**analytics** — The cube API passes the request's database handle to drizzle-cube in a form that type-checks against kit 0.15.0, whose `Database` is driver-neutral; without it an app with analytics fails `pnpm typecheck` after taking that kit.
[Porting note](plugins/analytics/docs/upgrades/3.4.1.md).

**connectors** — No change to connectors: this release exists because `analytics` needed a type fix to compile against kit 0.15.0's driver-neutral `Database`, and every plugin here ships at the repository's version.
[Porting note](plugins/connectors/docs/upgrades/3.4.1.md).

**m365** — No change to m365: this release exists because `analytics` needed a type fix to compile against kit 0.15.0's driver-neutral `Database`, and every plugin here ships at the repository's version.
[Porting note](plugins/m365/docs/upgrades/3.4.1.md).

**web-knowledge** — No change to web-knowledge: this release exists because `analytics` needed a type fix to compile against kit 0.15.0's driver-neutral `Database`, and every plugin here ships at the repository's version.
[Porting note](plugins/web-knowledge/docs/upgrades/3.4.1.md).

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
