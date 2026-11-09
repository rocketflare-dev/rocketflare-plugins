/**
 * The drizzle-cube API (D19): `/cubejs-api/v1/{load,meta,sql,batch,dry-run}` and `/mcp`, both
 * served by ONE router mounted twice in `../../index.ts` behind the kit's auth middleware.
 *
 * A fresh `createCubeApp` is built per request because the drizzle handle comes from the request's
 * client (`ctx.db` — postgres.js via Hyperdrive, or the Neon serverless driver from kit 0.15.0),
 * which does not exist at module scope in Workers; the adapter registers absolute paths, so the
 * raw request is forwarded rather than a prefix-stripped one.
 *
 * **The security context is built HERE and handed to the library as a closure** (D31). drizzle-cube
 * calls `extractSecurityContext` per query, from a place with no Hono context — so it gets
 * `ctx.detached()`, the kit's snapshot of a request that outlives the handler. Building a
 * `RequestCtx` in there is not possible and deliberately so: half of it is about a request.
 *

 * Access = tenant membership + `read Analytics`; row scoping happens inside every cube via
 * `tenantIdOf(ctx)` (`cubes/security.ts`) — see `cubes/CLAUDE.md`. CORS is the app's own middleware
 * (already ran); MCP origin policy is drizzle-cube's default (loopback + no-Origin clients such as
 * the Claude connector), tightened per deployment via `mcp.allowedOrigins`. Each request is limited
 * in batch length and in how long one statement may run (`../../services/cube-limits.ts`).
 */
import { ANALYTICS_SUBJECT } from '@rocketflare/shared/plugins/analytics/index'
import { createCubeApp } from 'drizzle-cube/adapters/hono'
import type { DrizzleDatabase } from 'drizzle-cube/server'
import type { Database, RequestCtx } from '@/plugins/api'
import { createRouter, requestCtx } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { cubesFor } from '../../cubes'
import { buildSecurityContext } from '../../cubes/security'
import {
  CUBE_BATCH_MAX,
  CUBE_STATEMENT_TIMEOUT_MS,
  withStatementTimeout,
} from '../../services/cube-limits'

export const cubeApiRouter = createRouter()

cubeApiRouter.all('*', async c => {
  // 401 / 403 no_tenant before any cube work — `requestCtx` resolves the same auth the kit's own
  // routes do.
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', ANALYTICS_SUBJECT)
  if (await batchTooLong(c.req.raw)) {
    ctx.badRequest(`A batch may hold at most ${CUBE_BATCH_MAX} queries`, 'cube_batch_too_large')
  }
  const securityContext = buildSecurityContext(ctx.detached())
  const serve = async (db: Database) =>
    createCubeApp({
      // Filtered per request rather than at module scope (D30): `allCubes` stays whole so the
      // isolation test can prove every cube's tenant scoping even while its feature ships dark.
      cubes: cubesFor(ctx.features),
      // From kit 0.15.0 `ctx.db` is the driver-neutral `PgDatabase` base (D35), whose raw `execute()`
      // is `unknown` — postgres.js resolves an array, the Neon driver `{ rows }`. drizzle-cube
      // declares `unknown[]` but normalises both shapes itself, so the handle is passed as its type.
      drizzle: db as unknown as DrizzleDatabase,
      // The declared way to hand a library the whole schema — every kit table AND every installed
      // plugin's. Called inside the handler, never at module scope.
      schema: allTables(),
      engineType: 'postgres',
      extractSecurityContext: () => securityContext,
      mcp: { enabled: true },
    }).fetch(c.req.raw)
  return withStatementTimeout(ctx.db, CUBE_STATEMENT_TIMEOUT_MS, serve)
})

/** Malformed JSON is the library's to answer; only a readable, over-long batch is refused here. */
async function batchTooLong(request: Request): Promise<boolean> {
  if (request.method !== 'POST' || !/\/batch\/?$/.test(new URL(request.url).pathname)) return false
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as { queries?: unknown } | null
  return Array.isArray(body?.queries) && body.queries.length > CUBE_BATCH_MAX
}
