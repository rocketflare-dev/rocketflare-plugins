---
version: unreleased
previous: 1.0.2
date: null
breaking: false
requires_kit: ">=0.7.0 <1.0.0"
migrations: []
areas: [api, ui, cli, tests, config]
touches_registries: []
manual: false
---

## What changed

**This plugin is written against the kit's plugin API now, and says so.** It declares
`requires.pluginApi: "1"`, which is what moves it from *warned* to *checked*: the host's import
rule fails the gate on anything that reaches past a declared entry, rather than printing a warning
nobody reads. The floor moves to kit `>=0.7.0`, the release that introduced the contract.

Nothing about what analytics DOES changed. Every route answers what it answered, every cube scopes
itself the way it did, the dashboards, templates, fact table and CLI commands are untouched. What
changed is where the code reaches for the host. It was measured at **105 distinct (module, symbol)
pairs across 43 kit modules** — six-level relative climbs into `apps/web/tests/**`, direct imports
of `withAuthAndDb`, `guardPermission`, `uuidParam`, `enqueueJob`, `NotFoundError`, the schema
barrel — and it is now the one sentence the contract makes true: *a plugin imports only from
declared entries, and receives everything else as injected context.*

Where each kind of call site went:

| Was | Is |
|---|---|
| `withAuthAndDb(c)`, `guardPermission`, `uuidParam`, `c.req.valid`, typed errors, `enqueueJob`, `nudge`, `accessScopeOf`, `isAdminLevel` | `const ctx: RequestCtx = requestCtx(c)` — `ctx.guard`, `ctx.uuid`, `ctx.valid`, `ctx.notFound`/`forbidden`/`badRequest`, `ctx.enqueue`, `ctx.nudge`, `ctx.scope`, `ctx.isAdmin` |
| the cron task's `TaskContext` | `CronCtx`, through the kit's `cronCtx` adapter, called once at the registration boundary |
| the refresh job's `JobContext` | `JobCtx`, through `jobCtx`, same shape |
| `onTenantCreated(db, tenantId, …)` / `seedDemo(db, ctx)` | `HookCtx` / `SeedCtx` |
| `db/schema/_helpers`, `db/schema/rls`, `db/schema/tenants`, `db/schema/users`, `db/schema/groups` | `@/db/schema/kit`, imported **by relative path** in a table file — drizzle-kit bundles those and resolves no tsconfig alias |
| `@/ui/components/shared`, `@/ui/hooks/*`, `@/ui/lib/*` in pages | `@/plugins/api/ui` |
| `@/plugins/types`, `@/ui/hooks/useNavGuard` in `ui/index.ts` | `@/plugins/api/ui-wiring` — the half that may ship in the main bundle |
| `../../../../../tests/helpers/{auth,db,request}`, `tests/mocks/bindings`, `tests/ui/helpers/renderWithProviders` | `@testkit/integration`; the context builders are `@testkit/unit` |
| `../../context`, `../../errors`, `../../utils/output` in the CLI | `../api` |

**Four call sites fit no context, and each is now deliberate rather than incidental.**

- `extensions.ts` read `serverPlugins` from the server barrel to find other plugins' cubes. It uses
  the kit's `extensions(key)` / `extensionSources(key)` accessors from `@/plugins/api/peers`, and
  they are called **inside functions** — a module-scope read closes a cycle through the barrel and
  fails at IMPORT time, taking the Worker down rather than one request.
- `cube-api.ts` handed the whole drizzle schema namespace to `createCubeApp({ schema })`. That is
  `allTables()` from the same module, called inside the handler. Its doc comment is worth reading
  before anyone copies the pattern: it is not "your tables", it is every table in the application,
  and its shape changes when somebody installs a plugin you have never heard of.
- `cubes/security.ts` read `c.get('auth')` from inside a drizzle-cube callback, where no request
  exists. **The security context is now built in the route from `ctx.detached()`** and passed down.
  `RequestCtx` is deliberately not widened to work outside a handler, and this is the case
  `DetachedCtx` exists for.
- `Database` and `Logger` stayed nameable as types (`@/plugins/api`), which is what lets this
  plugin's own `(db, tenantId, …)` services keep the kit's service shape.

**Two consequences worth knowing, because they are visible in the code rather than only in the
imports.**

*Writing a dashboard's visibility goes through the kit.* `ctx.visibility.resolve`, `.set` and
`.grantsFor` dispatch through the registry entry this plugin declares, so the two rules they carry
are the kit's own rather than a restatement: a group id is checked against the tenant before it is
stored, and a member may share only with groups they are in (403 `group_not_yours`).

*The visibility nudge now names the query-key root.* It emitted `entity: 'analytics'` while the
query-key family root is `analytics:dashboards`, so the invalidation never matched and an open tab
learned about a visibility change on its next fetch. It emits `ANALYTICS_DASHBOARDS_ENTITY` —
the same constant the UI and `SharedPlugin.realtimeRoots` use, which is the kit's convention and
the whole reason the socket wiring is free.

### What this migration found, and what the kit changed

Seven gaps were reported while porting, and **every one of them was fixed in the kit before this
release** — which is the point of migrating a real plugin rather than the reference one. Nothing
here works around anything:

- **A second installed plugin could not call `createRouter()` at module scope.** `@/plugins/api`
  re-exports it through `./http`, which imported `api/services/access` — a module that reads the
  plugin barrel — sixteen lines before it imported `api/utils/routes/router`. So every installed
  plugin was evaluated from inside `@/plugins/api`'s own dependency graph while `createRouter` was
  still an uninitialised binding: `createRouter is not a function`, at import time, from whichever
  entry loaded a plugin index first. It needed TWO plugins to show, and two plugins is the kit's
  own default state. Analytics never hit it before because it imported `router.ts` directly; the
  declared entry cannot. Fixed by moving `accessScopeOf` into the leaf `api/services/access-sql.ts`,
  re-exporting it from `access.ts` so no core importer moved, and pointing `plugins/api/http.ts` at
  the leaf — that third edit is the one that breaks the cycle.
- **`@/db/schema/kit` now exports `activity_events`, `tenant_users` and `group_types`**, so the
  cubes and the fact-table registry are ordinary module-scope consts naming ordinary kit tables.
- **`notifyUnauthorized` and `setUnauthorizedHandler` are on `@/plugins/api/ui`**, so a cube 401
  reaches the kit's global handler directly.

- **The visibility write helpers are published as `ctx.visibility`.** `grantsForResources`,
  `setResourceGroups` and `resolveRequestedVisibility` were on no declared entry, and this plugin
  briefly carried a `services/visibility.ts` reimplementing all three. They could not simply be
  exported — they dispatch through `VISIBILITY_RESOURCES`, which reads the plugin barrel, so a
  plugin importing that module reintroduces the cycle above. The kit INJECTS them instead, reaching
  the composing module through a function-scope `await import(...)`. **That file is deleted here**,
  which is the only proof that the published helpers are equivalent to what it reimplemented.
- **`ctx.groups` carries the reader's groups with their TYPE names.** `groupFilter(ctx,
  'Department', column)` narrows by type and `AccessScope` carries ids alone, so
  `cubes/security.ts` was resolving the names with one query per cube request. They were already on
  the session; `buildSecurityContext` is now pure and does no I/O at all.
- **`@testkit/integration` publishes the cron dispatcher.** `scheduled-facts.test.ts` had been
  reduced to asserting that the task existed and separately that it worked, with a comment saying
  the half it could no longer see was the host dispatching it. It dispatches `'15 * * * *'` through
  the host again, and asserts the report says `status: 'ok'`.
- **`group_members` is on `@/db/schema/kit`**, so `dashboard-visibility.test.ts` names it instead of
  digging it out of `allTables()`.

## How to apply

Upgrade the kit to 0.7.0 or later first (`pnpm kit:upgrade`), then `pnpm plugin upgrade analytics`.
There is no migration and no schema change: not one table, column, index or RLS policy moved.

If you have edited this plugin in your own copy, the conflicts are listed below and the rule for
resolving them is the same one the kit states: take the new import, keep your change. The diagnostic
from `pnpm test` names the replacement for every line it refuses, so a rejected hunk tells you what
it wanted.

If you have written a plugin that CONTRIBUTES to this one through `analyticsExtensions({...})`,
nothing changes — the four extension keys, their shapes and the "a cube with no isolation case fails
the suite" rule are all unchanged.

## Conflicts to expect

Every file in the plugin changed its imports, so a copy that has edited any of them will reject.
The ones with more than an import change, and worth reading rather than re-applying blind:

- `apps/web/src/plugins/analytics/cubes/security.ts` — `extractSecurityContext(c)` is gone;
  the pure `buildSecurityContext(detached)` and `analyticsSecurityContext(reader, memberships)`
  replace it, and `readerGroups` is deleted with the query it ran.
- `apps/web/src/plugins/analytics/services/dashboard-templates.ts` — `resetToTemplate(ctx, pageId)`
  takes the request context, because the errors it throws come off it.
- The tests moved to `@testkit`, and `tests/config/permissions.test.ts` became
  `tests/api/permissions.test.ts` (the declared ability check needs the harness's database).

## Verify

```bash
pnpm plugin check            # exits 0, and is now STRICT: requires.pluginApi is declared
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The two tests to watch are the ones that carry this plugin's reason for existing, and both are
unchanged in what they assert:

- `cube-isolation.test.ts` — every cube in `allCubes()` driven through the real
  `POST /cubejs-api/v1/load` as two tenants, each seeing only its own rows, with the coverage
  assertion still comparing the case keys to the whole registry.
- `dashboard-visibility.test.ts` — one restricted dashboard past five kinds of reader, an EMPTY
  grant list still private rather than public, and a hidden page still answering the SAME 404 as a
  missing one.
