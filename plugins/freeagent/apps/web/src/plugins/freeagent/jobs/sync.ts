/**
 * `freeagent.sync` — registered in `ServerPlugin.jobHandlers`. The work is `services/sync.ts`;
 * this is the adapter. A throw (rate limited, FreeAgent down, Postgres unavailable) retries with
 * the kit's backoff, which is safe because the sync is incremental and idempotent; a connection
 * that needs reconnecting returns normally, because no retry can fix it.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import type { FREEAGENT_SYNC_JOB } from '@rocketflare/shared/plugins/freeagent/index'
import type { JobHandler } from '@/plugins/api'
import { jobCtx } from '@/plugins/api'
import { syncTenant } from '../services/sync'

export const handleFreeagentSync: JobHandler<typeof FREEAGENT_SYNC_JOB> = async (
  job: JobOf<typeof FREEAGENT_SYNC_JOB>,
  ctx
) => {
  await syncTenant(jobCtx(ctx), job.payload.tenantId)
}
