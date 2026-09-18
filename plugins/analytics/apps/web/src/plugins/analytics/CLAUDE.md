# `analytics` — the analytics plugin (D31, Phase C)

Dashboards, the semantic layer, the drizzle-cube API and one example fact table. It was the kit's
§8 until 0.6.0; it is now a plugin, and the kit knows nothing about drizzle-cube.
`docs/CONCEPTS.md` §8 is the pointer, this directory is the reference.

Install: `pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugin-analytics.git@1.0.2 --apply`
— it is in `.rocketflare.json` `defaultPlugins`, so `bash scripts/bootstrap.sh` installs it for you.

## The four published entries, and nothing else

| Entry | What it declares |
|---|---|
| `index.ts` | `mounts` (`/api/analytics`, `/cubejs-api`, `/mcp`), `apiPrefixes`, the refresh `jobHandlers`, `scheduledTasks['15 * * * *']`, `grants` for `Dashboard` / `Analytics`, `visibilityResources`, `hooks` — plus the extension helpers another plugin imports |
| `ui/index.ts` | three lazy routes, one nav item, one Home quick link, the query-key family |
| `@rocketflare/shared/plugins/analytics/index` | the contracts, the two CASL subjects, the `analytics.refresh-facts` job, the realtime root |
| `apps/cli/src/plugins/analytics/index.ts` | `rocketflare analytics pages list \| check-facts \| refresh-facts` |

Everything else here is private. Core reaching past those four, or another plugin doing it, is a
`tests/config/plugins.test.ts` failure rather than a convention.

## The three rules this plugin exists to demonstrate

**Cubes scope themselves, and nothing else does it for them.** Every cube filters on
`tenantIdOf(ctx)` inside its own `sql()`; drizzle-cube joins whatever a query asks for and adds no
second line of defence, so `tests/api/cube-isolation.test.ts` is mandatory and its coverage
assertion compares the case keys to `allCubes()`. A cube with no case fails the host's suite.
`cubes/CLAUDE.md` is the detail.

**Another plugin may contribute, and it is narrowed loudly.** `extensions.ts` reads every installed
plugin's `extensions` for `analytics:{cubes,factTables,dashboardTemplates,cubeIsolationCases}`,
zod-narrows each, and THROWS naming the contributing plugin when it cannot. `unknown[]` at the core
boundary is the point (D31 decision 6): the kit stays ignorant of what a "cube" is.

**Three registries are FUNCTIONS, not consts, and that is load-bearing.** `allCubes()`,
`factTables()` and `DASHBOARD_TEMPLATES()` read the server plugin barrel, which imports this
plugin — so evaluated at module scope one side finds `serverPlugins` still `undefined` and the
Worker fails at import, not at request. Read at call time, live bindings are always resolved; each
memoises. The same rule put `sharedWithMyGroups` in the leaf `api/services/access-sql.ts` and made
the kit's `visibilityResources()` a function.

## Bundle boundaries

`dashboards/registry.ts` is pure data the BROWSER may import; `dashboards/index.ts` composes in
other plugins' templates and therefore drags the whole Worker — keep the UI on `registry`.
`ui/index.ts` ships in the main bundle, so every page is `lazy(() => import(...))` and
drizzle-cube, recharts, d3 and react-grid-layout stay inside the analytics chunk
(`grep -c recharts apps/web/dist/ui/assets/index-*.js` must be 0).
`drizzle-cube-theme.css` sits beside the library's own stylesheet in `CubeClientProvider`, so a
bare kit carries none of it.

## What the host has to do by hand

A plugin edits no toml, no `package.json` and no core file. `pnpm plugin add` prints these; this is
the list:

- `[triggers].crons` in BOTH wrangler tomls gains `"15 * * * *"`, and `[assets].run_worker_first`
  gains `/cubejs-api`, `/cubejs-api/*`, `/mcp`, `/mcp/*` (the parity test reads `API_PREFIXES`, so
  a forgotten one fails the gate rather than silently serving the app shell).
- `apps/web/vite.config.ts`: `/cubejs-api` and `/mcp` in the dev proxy, `'@nivo/heatmap'` aliased to
  `./src/plugins/analytics/ui/lib/nivo-heatmap.tsx` (drizzle-cube's heat-map chunk names that
  optional peer and Rollup fails without it), and `'recharts'` in `dedupe`.
- `pnpm db:generate --name plugin-analytics-1.0.2`, then `pnpm db:migrate`.

## Things that moved and are not coming back

`pnpm web db:refresh-facts` and `db:check-facts` were `apps/web/scripts/*.ts`, which is not a
directory a plugin may own. They are `rocketflare analytics refresh-facts` and `check-facts` now:
one organisation rather than every tenant, over a route rather than a bare `DATABASE_URL`, and the
refresh ENQUEUES (`analytics.refresh-facts`) because a route never runs long work. The `:15` cron is
still the cross-tenant path and is unchanged.

The fact table is `analytics_tenant_activity_daily_facts` — the `<id>_*` rule. There is no
compatibility path (D31 decision 7): an app that carried the kit's `tenant_activity_daily_facts`
sees it dropped and the new one rebuilt by the next cron. `analytics_pages` and
`analytics_page_groups` already carried the prefix, so their ROWS survive untouched.
