/**
 * The contributed cubes scope by tenant — proven here WITHOUT the analytics plugin, by running each
 * cube's own base query (`sql(ctx)` → `{ from, where }`) against Postgres as two tenants, seeded by
 * the same isolation cases analytics would run. When analytics is installed its cube-isolation test
 * runs those cases again through `/cubejs-api`.
 */
import { createTestTenant, setupTestDatabase } from '@testkit/integration'
import { describe, expect, it } from 'vitest'
import {
  FREEAGENT_ANALYTICS_EXTENSIONS,
  FREEAGENT_CUBE_ISOLATION_CASES,
  FREEAGENT_CUBES,
  tenantOf,
} from '../../cubes'

const db = setupTestDatabase()

describe('freeagent cubes', () => {
  it('has exactly one isolation case per cube, under the analytics keys', () => {
    expect(FREEAGENT_CUBE_ISOLATION_CASES.map(c => c.cube).sort()).toEqual(
      FREEAGENT_CUBES.map(c => c.name).sort()
    )
    expect(Object.keys(FREEAGENT_ANALYTICS_EXTENSIONS).sort()).toEqual([
      'analytics:cubeIsolationCases',
      'analytics:cubes',
    ])
  })

  it('refuses a query with no tenant', () => {
    expect(() => tenantOf({ securityContext: {} })).toThrow()
    for (const cube of FREEAGENT_CUBES) expect(() => cube.sql({ securityContext: {} })).toThrow()
  })

  it('every cube’s base query answers only the querying tenant’s rows', async () => {
    const a = (await createTestTenant(db)).id
    const b = (await createTestTenant(db)).id
    for (const c of FREEAGENT_CUBE_ISOLATION_CASES) {
      await c.seed(db, { tenantId: a, userId: a })
      await c.seed(db, { tenantId: b, userId: b })
    }
    for (const cube of FREEAGENT_CUBES) {
      for (const [mine, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const { from, where } = cube.sql({ securityContext: { tenantId: mine } })
        // biome-ignore lint/suspicious/noExplicitAny: the cube's `from` is one of this plugin's tables
        const rows = (await db
          .select()
          .from(from as any)
          .where(where)) as Array<{ tenantId: string }>
        expect(rows.length, cube.name).toBeGreaterThan(0)
        expect(
          rows.every(r => r.tenantId === mine),
          cube.name
        ).toBe(true)
        expect(JSON.stringify(rows)).not.toContain(other)
      }
    }
  })
})
