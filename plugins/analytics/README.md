# analytics

> Dashboards, a tenant-scoped semantic layer and an MCP endpoint for your Rocketflare app, built on
> [drizzle-cube](https://www.drizzle-cube.dev).

The analytics plugin was the kit's own analytics subsystem until kit 0.6.0; it is now a plugin, and
the kit's bootstrap installs it by default (`defaultPlugins` in `.rocketflare.json`). Everything it
answers is scoped to the reader's organisation.

## What it adds

| Area | What you get |
|---|---|
| UI | **Analytics** in the side nav and a Home quick link: `/analytics` (dashboards), `/analytics/explore` (a query builder over the cubes) and `/analytics/:pageId` (one dashboard). New organisations get a set of default dashboards |
| Semantic layer | drizzle-cube cubes over the kit's own data — `ActivityEvents`, `Users`, `Members`, `TenantUsers` and `TenantActivityDaily` — each filtering on the reader's tenant inside its own SQL |
| API | `/api/analytics` (dashboards: list, read, create, update, delete, restrict to groups), `/cubejs-api/v1` (the Cube.js-compatible query API: `meta`, `load`, `sql`, `dry-run`, `explain`, `batch`) and `/mcp` (an MCP server with `discover`, `validate` and `load` tools) |
| Background work | One fact table, `analytics_tenant_activity_daily_facts`, rebuilt every hour by the `15 * * * *` cron; the `analytics.refresh-facts` job refreshes one organisation on demand |
| Data | `analytics_pages`, `analytics_page_groups`, `analytics_tenant_activity_daily_facts` — all tenant-scoped with row-level security |
| CLI | `rocketflare analytics pages list`, `rocketflare analytics check-facts`, `rocketflare analytics refresh-facts` |
| Agent skills | `analytics` (start here: health check and routing), `analytics-cubes` (define and extend cubes, the isolation test), `analytics-queries` (query the API, connect Claude Code or Claude Desktop to `/mcp`), `analytics-dashboards` (dashboards, templates, group visibility) |

Other plugins can contribute cubes, fact tables, dashboard templates and isolation cases through
`extensions`; the plugin reads and validates them, failing loudly and naming the contributor when
one is malformed.

## Requirements

- Rocketflare kit **0.13.0** or later (`minKit`; earlier plugin releases support older kits).
- No other plugin, no bindings and no secrets.
- npm dependencies the install adds to `apps/web`: `drizzle-cube` (pinned 0.8.3), `recharts`, `d3`,
  `react-grid-layout`, `react-is`.

## Install

A fresh copy of the kit already has it. To add it yourself — the first command prints the plan and
stops, the second applies it:

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.3.0 --subdir plugins/analytics
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.3.0 --subdir plugins/analytics --apply
pnpm db:generate --name plugin-analytics-3.3.0 && pnpm db:migrate
```

The plan lists the steps a plugin cannot make in your files, and `pnpm provision cloudflare <env>`
writes the toml half of them:

- both wrangler tomls: the `15 * * * *` cron, and `/cubejs-api`, `/cubejs-api/*`, `/mcp`, `/mcp/*`
  in `[assets] run_worker_first`;
- `apps/web/vite.config.ts`: `/cubejs-api` and `/mcp` in the dev proxy, the `@nivo/heatmap` alias
  and `recharts` in `dedupe`.

## First run

1. `pnpm dev`, sign in, and open **Analytics**. An organisation created before the install gets its
   default dashboards the first time the list is opened.
2. Open **Explore** to build a query over the cubes.
3. `rocketflare analytics check-facts` shows whether the fact table is fresh;
   `rocketflare analytics refresh-facts` rebuilds it for your organisation now instead of at `:15`.

## Using it with your coding agent

Ask for what you want — "add a revenue measure to the orders cube", "show me active users by week",
"connect Claude Desktop to our analytics" — and the `analytics-*` skills take it from there. They
know this plugin's conventions (tenant scoping, frozen member names, the isolation test) as well as
drizzle-cube's. drizzle-cube's own [Claude Code plugin](https://www.drizzle-cube.dev/ai/claude-code-plugin/)
is an optional complement.

## Permissions and data

- Owners, admins and support can manage dashboards; members can read them. Everyone with a
  membership can query the cubes.
- Every cube filters on the reader's tenant itself — drizzle-cube adds no second line of defence — so
  every cube, contributed ones included, must have a case in the plugin's cube-isolation test, and
  the host's suite fails if one is missing.
- Dashboards can be restricted to groups; a restricted dashboard answers the same 404 as a missing
  one.
- `/cubejs-api` and `/mcp` accept a session or an API key, and answer only for that key's tenant.

## Known gaps

- drizzle-cube is pinned to 0.8.3; newer drizzle-cube features (for example the MCP chart tool) are
  not enabled.
- One example fact table; anything else you model is yours to add (the `analytics-cubes` skill
  walks through it).
- Claude Desktop reaches `/mcp` through the `mcp-remote` bridge, because Desktop's custom
  connectors support OAuth only.

## More

- [`CLAUDE.md`](apps/web/src/plugins/analytics/CLAUDE.md) — the plugin's reference: entries, rules,
  bundle boundaries.
- [`cubes/CLAUDE.md`](apps/web/src/plugins/analytics/cubes/CLAUDE.md) — writing a cube.
- [Upgrade notes](docs/upgrades/) — one per release.
- The kit: [plugins](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#16-plugins)
  and [analytics](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#8-analytics)
  in `docs/CONCEPTS.md`.
