---
version: unreleased
previous: 3.7.0
date: null
breaking: false
migrations: []
areas: [ui, tests, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

analytics now compiles on React 19 with React Router 7 as well as on React 18 with Router 6, so a host can move to either. Imports stay on `react-router-dom`. drizzle-cube moves from 0.8.3 to 0.12.2, which declares React 19 and fixes a stored XSS in markdown portlets (GHSA-g3qv-p2w6-c95h).

- `ui/pages/QueryBuilderPage.tsx`: `SavePortletModal`'s `builder` prop is `React.RefObject<AnalysisBuilderRef | null>`. React 19's `useRef<T>(null)` returns that type, and React 18's `RefObject<T>` still fits it.
- `tests/ui/date-filter.test.tsx`: the `<MemoryRouter>` loses its `future` prop. Router 7 removed the v7 future flags. Router 6 warns once instead, and the kit's `tests/ui/setup.ts` filters that warning.
- `rocketflare-plugin.json` and its anchor copy, the `@nivo/heatmap` alias in `apps/web/vite.config.ts`: `path.resolve(import.meta.dirname, …)` replaces `__dirname`, which Vite 8's native config loader warns about.
- `rocketflare-plugin.json` and its anchor copy: `drizzle-cube` is pinned at `0.12.2`. Every type the plugin imports changed only by gaining optional fields, and 0.12.2 reads a stored `analytics_pages` config as it is. Three behaviour changes reach an app:
  - `/cubejs-api/v1/load` and MCP `load` return only the time buckets that have rows. Dashboards and Explore fill the gaps on the client and look the same. A caller that wants a zero row per empty bucket sets `fillMissingDates: true` on the time dimension.
  - A `timeDimensions` entry without `granularity` filters and no longer groups, so the Organisation Overview "Active Users (30d)" KPI is one distinct count over 30 days.
  - A date string drizzle-cube cannot parse, an unknown operator, or a measure filter in an ungrouped query is a 400 instead of being dropped.
- `dashboards/general-templates/tenant-overview.ts`: the Organisation Overview "Recent Members" table pins the date filter to `TenantUsers.joinedAt`. It has no `timeDimensions`, so the filter never narrowed it, and drizzle-cube 0.10.1 and later shows a warning on such a card. `tests/config/all-templates.test.ts` now fails a portlet mapped to a universal time filter it cannot reach.
- `ui/hooks/useDashboardDateFilter.ts`: the page date control overrides the universal time filter's `dateRange` as well as its `values`. drizzle-cube reads `dateRange` first, and its filter editor saves one, so after anyone edited a dashboard's date filter the 7/30/90-day control stopped changing that dashboard.
- The `analytics*` skills, `README.md` and the dashboard docs name 0.12.2 and its query rules.

## How to apply

1. Run `pnpm plugin upgrade analytics --apply`. It replaces the changed source, test and skill files, the `'@nivo/heatmap'` line in `apps/web/vite.config.ts`, and the `drizzle-cube` pin in `apps/web/package.json`.
2. Run `pnpm install`.
3. Existing Organisation Overview pages keep the old mapping and show the warning on "Recent Members". To fix one, a member with manage Dashboard resets it: `POST /api/analytics/pages/:id/reset`, or `POST /api/analytics/templates/recreate` for every template page in the organisation. A reset discards that page's own edits, so skip it for a page the organisation has customised and remap the card in the editor instead.

## Conflicts to expect

`apps/web/vite.config.ts` → if the app already changed the `'@nivo/heatmap'` line by hand, keep one line, the one that uses `import.meta.dirname`.

`apps/web/package.json` → if the app pinned `drizzle-cube` itself, take `0.12.2`.

## Verify

1. `rg -c "'@nivo/heatmap'" apps/web/vite.config.ts` prints `1`, and the line uses `import.meta.dirname`.
2. `pnpm gate` passes and prints no `(!)` warning about `configLoader: 'native'`.
3. `pnpm --filter @rocketflare/web why drizzle-cube` resolves `0.12.2` only.
4. On a dashboard whose date filter was edited and saved in the editor, the page date control still changes every mapped chart.
5. On a reset Organisation Overview page, "Recent Members" shows no warning and follows the date control.
