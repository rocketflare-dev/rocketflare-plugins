/**
 * The drizzle-cube API (D19): `/cubejs-api/v1/{load,meta,sql,batch,dry-run}` and `/mcp`, both
 * served by ONE router mounted twice in `../../index.ts` behind the kit's auth middleware.
 *
 * A fresh `createCubeApp` is built per request because the drizzle handle comes from the request's
 * Hyperdrive-backed client (`ctx.db`), which does not exist at module scope in Workers; the adapter
 * registers absolute paths, so the raw request is forwarded rather than a prefix-stripped one.
 *
 * **The security context is built HERE and handed to the library as a closure** (D31). drizzle-cube
 * calls `extractSecurityContext` per query, from a place with no Hono context — so it gets
 * `ctx.detached()`, the kit's snapshot of a request that outlives the handler. Building a
 * `RequestCtx` in there is not possible and deliberately so: half of it is about a request.
 *

 * **The router is built on FIRST READ, not at module scope, and that is not a style choice.**
 * `@/plugins/api` re-exports `createRouter` through `./http`, and `./http` imports
 * `api/services/access` — which reads the server plugin barrel, which imports every installed
 * plugin. So when a SECOND plugin is evaluated it is reached from inside `@/plugins/api`'s own
 * dependency graph, before `api/utils/routes/router` has been evaluated, and `createRouter` is
 * still an uninitialised binding: `createRouter is not a function`, at import time, from whichever
 * entry point happens to load a plugin entry first. Analytics never hit this before the migration
 * because it imported `router.ts` directly; the declared entry cannot. Deferring the call until the
 * host reads `mounts` puts it after every module has evaluated. Reported to the kit — the fix
 * belongs there (`accessScopeOf` in the leaf, or `./http`'s imports ordered), not in every plugin.
 *
 * Access = tenant membership + `read Analytics`; row scoping happens inside every cube via
 * `tenantIdOf(ctx)` (`cubes/security.ts`) — see `cubes/CLAUDE.md`. CORS is the app's own middleware
 * (already ran); MCP origin policy is drizzle-cube's default (loopback + no-Origin clients such as
 * the Claude connector), tightened per deployment via `mcp.allowedOrigins`.
 */
import { ANALYTICS_SUBJECT } from '@rocketflare/shared/plugins/analytics/index'
import { createCubeApp } from 'drizzle-cube/adapters/hono'
import type { AppRouter, RequestCtx } from '@/plugins/api'
import { createRouter, requestCtx } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { cubesFor } from '../../cubes'
import { buildSecurityContext } from '../../cubes/security'

let memo: AppRouter | null = null

/** Built on first read — see the header. Memoised, so both mounts share one router. */
export function cubeApiRouter(): AppRouter {
  if (memo) return memo
  const router = createRouter()

  router.all('*', async c => {
    // 401 / 403 no_tenant before any cube work — `requestCtx` resolves the same auth the kit's own
    // routes do.
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('read', ANALYTICS_SUBJECT)
    const securityContext = await buildSecurityContext(ctx.detached())
    const cubeApp = createCubeApp({
      // Filtered per request rather than at module scope (D30): `allCubes` stays whole so the
      // isolation test can prove every cube's tenant scoping even while its feature ships dark.
      cubes: cubesFor(ctx.features),
      drizzle: ctx.db,
      // The declared way to hand a library the whole schema — every kit table AND every installed
      // plugin's. Called inside the handler, never at module scope.
      schema: allTables(),
      engineType: 'postgres',
      extractSecurityContext: () => securityContext,
      mcp: { enabled: true },
    })
    return cubeApp.fetch(c.req.raw)
  })

  memo = router
  return router
}
