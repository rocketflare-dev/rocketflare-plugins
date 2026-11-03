---
version: unreleased
previous: 3.7.0
date: null
breaking: false
migrations: []
areas: [ui, tests, config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

analytics now compiles on React 19 with React Router 7 as well as on React 18 with Router 6, so a host can move to either. Imports stay on `react-router-dom`.

- `ui/pages/QueryBuilderPage.tsx`: `SavePortletModal`'s `builder` prop is `React.RefObject<AnalysisBuilderRef | null>`. React 19's `useRef<T>(null)` returns that type, and React 18's `RefObject<T>` still fits it.
- `tests/ui/date-filter.test.tsx`: the `<MemoryRouter>` loses its `future` prop. Router 7 removed the v7 future flags. Router 6 warns once instead, and the kit's `tests/ui/setup.ts` filters that warning.
- `rocketflare-plugin.json` and its anchor copy, the `@nivo/heatmap` alias in `apps/web/vite.config.ts`: `path.resolve(import.meta.dirname, …)` replaces `__dirname`, which Vite 8's native config loader warns about.

## How to apply

1. Run `pnpm plugin upgrade analytics --apply`. It replaces the two source files and the `'@nivo/heatmap'` line in `apps/web/vite.config.ts`.

## Conflicts to expect

`apps/web/vite.config.ts` → if the app already changed the `'@nivo/heatmap'` line by hand, keep one line, the one that uses `import.meta.dirname`.

## Verify

1. `rg -c "'@nivo/heatmap'" apps/web/vite.config.ts` prints `1`, and the line uses `import.meta.dirname`.
2. `pnpm gate` passes and prints no `(!)` warning about `configLoader: 'native'`.
