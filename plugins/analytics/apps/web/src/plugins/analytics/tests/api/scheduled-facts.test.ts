/**
 * The `"15 * * * *"` cron (D19) rebuilds the fact tables through the host's plain dispatcher.
 *
 * The cron EXPRESSION is the host's — it lives in `[triggers].crons` in both wrangler tomls, which
 * a plugin may not edit — and the TASK is this plugin's, contributed through
 * `ServerPlugin.scheduledTasks` (D31). This test is what proves the two met: a task registered
 * under an expression no toml declares never runs, and nothing else would notice.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { dispatchScheduled, SCHEDULED_TASKS } from '@/api/scheduled'
import { activityEvents, tenantActivityDailyFacts } from '@/db/schema'
import { createTestTenantWithUser } from '../../../../../tests/helpers/auth'
import { setupTestDatabase } from '../../../../../tests/helpers/db'
import {
  createExecutionContext,
  createTestEnv,
  waitOnExecutionContext,
} from '../../../../../tests/mocks/bindings'

const db = setupTestDatabase()

describe('scheduled: fact-table refresh', () => {
  it('registers its refresh task on the hourly :15 cron the host dispatches', () => {
    expect(SCHEDULED_TASKS['15 * * * *']?.map(t => t.name)).toEqual(['analytics.refreshFactTables'])
  })

  it('dispatching the cron rebuilds the fact table for seeded activity', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    await db.insert(activityEvents).values([
      { tenantId: tenant.id, userId: user.id, type: 'cron.a' },
      { tenantId: tenant.id, userId: user.id, type: 'cron.b' },
    ])
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('15 * * * *', createTestEnv(), ctx)
    await waitOnExecutionContext(ctx)
    expect(reports).toEqual([
      expect.objectContaining({
        cron: '15 * * * *',
        task: 'analytics.refreshFactTables',
        status: 'ok',
      }),
    ])
    const rows = await db
      .select()
      .from(tenantActivityDailyFacts)
      .where(
        and(
          eq(tenantActivityDailyFacts.tenantId, tenant.id),
          eq(tenantActivityDailyFacts.userId, user.id)
        )
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.eventCount).toBe(2)
    expect(rows[0]?.distinctEventTypes).toBe(2)
  })
})
