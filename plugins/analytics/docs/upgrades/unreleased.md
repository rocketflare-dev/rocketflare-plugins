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

**Three consequences worth knowing, because they are visible in the code rather than only in the
imports.**

*The four cubes and the fact-table registry became memoised FACTORIES.* They name three kit tables —
`activity_events`, `tenant_users`, `group_types` — that `@/db/schema/kit` does not export, so those
arrive through `allTables()`, which must not be called at module scope. `kit-tables.ts` is the one
file that widens beyond the schema kit, and it is where this goes away the day those tables join it.
The cube definitions themselves are unchanged; the join thunks were already lazy.

*Writing a dashboard's visibility is the plugin's own code now.* The kit publishes what it takes to
DECLARE a restrictable resource, and reads that declaration for the predicate and the 409
`group_in_use` count — but not `grantsForResources`, `setResourceGroups` or
`resolveRequestedVisibility`. `services/visibility.ts` reimplements those three over this plugin's
own registry entry, keeping both rules they carry: a group id is checked against the tenant before
it is stored, and a member may share only with groups they are in (403 `group_not_yours`).

*The visibility nudge now names the query-key root.* It emitted `entity: 'analytics'` while the
query-key family root is `analytics:dashboards`, so the invalidation never matched and an open tab
learned about a visibility change on its next fetch. It emits `ANALYTICS_DASHBOARDS_ENTITY` —
the same constant the UI and `SharedPlugin.realtimeRoots` use, which is the kit's convention and
the whole reason the socket wiring is free.

### Four things the contract does not carry yet

Reported to the kit rather than worked around. None blocks this release; each costs something small
and visible, described where it bites.

1. **`@/db/schema/kit` exports three kit tables** (`tenants`, `users`, `groups`) and analytics needs
   three more at module scope. `kit-tables.ts` and the factory conversion are the cost.
2. **No group TYPE names on the auth context.** `AccessScope` carries group ids;
   `groupFilter(ctx, 'Department', column)` narrows by type. `cubes/security.ts` resolves them with
   one query per cube request, skipped entirely for an admin-level reader, who is never narrowed.
3. **`@testkit` publishes no cron dispatcher.** `scheduled-facts.test.ts` proved the task and the
   expression met by dispatching through the host's own `SCHEDULED_TASKS`. It now asserts the
   registered expression equals the one `plugin.json` declares, and drives the task through
   `makeCronCtx`. The half it can no longer see is the host actually dispatching it.
4. **`notifyUnauthorized` / `setUnauthorizedHandler` are not on `@/plugins/api/ui`.** A cube 401 has
   to reach the kit's global handler; the provider routes it through the declared `api` client,
   which calls that handler itself. One extra request, on the 401 path only.

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

- `apps/web/src/plugins/analytics/cubes/*.ts` — each cube is a memoised factory
  (`activityEventsCube()`), and `cubes/index.ts` exports `analyticsCubes()` where it exported the
  `ANALYTICS_CUBES` const. `allCubes()` and `cubesFor()` are unchanged.
- `apps/web/src/plugins/analytics/cubes/security.ts` — `extractSecurityContext(c)` is gone;
  `buildSecurityContext(detached)` and the pure `analyticsSecurityContext(reader, memberships)`
  replace it.
- `apps/web/src/plugins/analytics/services/fact-tables/registry.ts` — `ANALYTICS_FACT_TABLES` is
  `analyticsFactTables()`.
- `apps/web/src/plugins/analytics/services/dashboard-templates.ts` — `resetToTemplate(ctx, pageId)`
  takes the request context, because the errors it throws come off it.
- `apps/web/src/plugins/analytics/services/visibility.ts` is new.
- `apps/web/src/plugins/analytics/kit-tables.ts` is new.
- The tests moved to `@testkit`, `tests/config/permissions.test.ts` became
  `tests/api/permissions.test.ts` (the declared ability check needs the harness's database), and
  `tests/api/scheduled-facts.test.ts` no longer dispatches the cron.

## Verify

```bash
pnpm plugin check            # exits 0, and is now STRICT: requires.pluginApi is declared
pnpm typecheck && pnpm test && pnpm build
```

The two tests to watch are the ones that carry this plugin's reason for existing, and both are
unchanged in what they assert:

- `cube-isolation.test.ts` — every cube in `allCubes()` driven through the real
  `POST /cubejs-api/v1/load` as two tenants, each seeing only its own rows, with the coverage
  assertion still comparing the case keys to the whole registry.
- `dashboard-visibility.test.ts` — one restricted dashboard past five kinds of reader, an EMPTY
  grant list still private rather than public, and a hidden page still answering the SAME 404 as a
  missing one.
