/**
 * The one semantic layer both doors use: `/cubejs-api` (`api/routes/cube-api.ts`) and the cube
 * tools offered to MCP clients and agent runs (`tools/cube-tools.ts`). Building it in one place is
 * what keeps the two from drifting — the same cubes, the same schema, the same feature filter.
 *
 * Built per call, never at module scope: the drizzle handle is the caller's (`ctx.db`, or the
 * statement-timeout transaction wrapped around it), which does not exist when the module loads.
 */
import type { DrizzleDatabase } from 'drizzle-cube/server'
import { SemanticLayerCompiler } from 'drizzle-cube/server'
import type { Database } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { cubesFor } from '../cubes'

export function buildSemanticLayer(
  db: Database,
  features: readonly string[]
): SemanticLayerCompiler {
  const layer = new SemanticLayerCompiler({
    // From kit 0.15.0 `ctx.db` is the driver-neutral `PgDatabase` base, whose raw `execute()` is
    // `unknown` — postgres.js resolves an array, the Neon driver `{ rows }`. drizzle-cube declares
    // `unknown[]` but normalises both shapes itself, so the handle is passed as its type.
    drizzle: db as unknown as DrizzleDatabase,
    // The declared way to hand a library the whole schema — every kit table AND every installed
    // plugin's. Called here, per call, never at module scope.
    schema: allTables(),
    engineType: 'postgres',
  })
  // Filtered per call (feature flags): `allCubes` stays whole so the isolation test can prove every
  // cube's tenant scoping even while its feature ships dark.
  for (const cube of cubesFor(features)) layer.registerCube(cube)
  return layer
}
