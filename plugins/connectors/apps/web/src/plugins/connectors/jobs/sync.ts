/**
 * `connectors.sync` — advance ONE sync cursor (see `services/sync.ts` for the engine).
 *
 * The tenant comes from the payload, as every job's does; the handler re-reads the cursor, its
 * connection and its installation under that tenant, so a job enqueued before a disconnect finds
 * nothing and acks. Everything is awaited — there is no `waitUntil` in a consumer — and only an
 * UNEXPECTED failure throws; throttling, expired cursors and revoked consent are answered, not
 * retried blindly. `jobCtx` adapts the kit's context once, at the registration boundary below.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import type { CONNECTORS_SYNC_JOB } from '@rocketflare/shared/plugins/connectors/index'
import type { JobCtx, JobHandler } from '@/plugins/api'
import { jobCtx } from '@/plugins/api'
import { runSync } from '../services/sync'

export async function syncCursor(
  job: JobOf<typeof CONNECTORS_SYNC_JOB>,
  ctx: JobCtx
): Promise<void> {
  const outcome = await runSync(ctx, job.payload)
  ctx.logger.debug({ cursorId: job.payload.cursorId, outcome }, 'connectors.sync')
}

export const handleConnectorsSync: JobHandler<typeof CONNECTORS_SYNC_JOB> = (job, ctx) =>
  syncCursor(job, jobCtx(ctx))
