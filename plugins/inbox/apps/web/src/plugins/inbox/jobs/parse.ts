/**
 * `inbox.parse` — registered in `ServerPlugin.jobHandlers`. The work is `services/parse.ts`; this
 * is the adapter. A throw (R2 or Postgres unavailable, a malformed consumer contribution) retries
 * with the kit's backoff, which is safe because the parse is idempotent.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import type { INBOX_PARSE_JOB } from '@rocketflare/shared/plugins/inbox/index'
import type { JobHandler } from '@/plugins/api'
import { jobCtx } from '@/plugins/api'
import { parseMessage } from '../services/parse'

export const handleInboxParse: JobHandler<typeof INBOX_PARSE_JOB> = (
  job: JobOf<typeof INBOX_PARSE_JOB>,
  ctx
) => parseMessage(jobCtx(ctx), job.payload.tenantId, job.payload.messageId)
