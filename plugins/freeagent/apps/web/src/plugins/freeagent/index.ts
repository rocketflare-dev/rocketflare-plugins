/**
 * `freeagent` — the server entry (D31). Read top to bottom: the authed mount, the public OAuth
 * callback, the one job, the half-hourly cron, the agent tools, the grants and the analytics
 * contribution.
 *
 * What it exports beyond the `ServerPlugin` is the service API another plugin builds on — a
 * receipts matcher explains transactions and attaches receipts through these, and rematches after
 * each sync through `FreeAgentSyncListener` (`freeagent:sync-listeners`). They are part of this
 * plugin's four-entry surface, and its semver covers them.
 */
import {
  FREEAGENT_SUBJECT,
  FREEAGENT_SYNC_JOB,
  freeagentShared,
} from '@rocketflare/shared/plugins/freeagent/index'
import type { ServerPlugin } from '@/plugins/api'
import { toolCtx } from '@/plugins/api'
import { freeagentHooksRouter } from './api/hooks'
import { freeagentRouter } from './api/routes'
import { enqueueSyncsTask, FREEAGENT_CRON } from './api/scheduled'
import { FREEAGENT_ANALYTICS_EXTENSIONS } from './cubes'
import { handleFreeagentSync } from './jobs/sync'
import { freeagentAgentTools } from './tools/freeagent-tools'

export type { FreeAgentClient, Query as FreeAgentQuery } from './services/client'
export type { FreeAgentCtx } from './services/connection'
export { freeagentClientFor } from './services/connection'
export type { FreeAgentErrorCode } from './services/errors'
export { FreeAgentError, isFreeAgentError } from './services/errors'
export type { FreeAgentSyncListener, FreeAgentSyncSummary } from './services/sync'
export type {
  AttachmentInput,
  BillView,
  ExplanationView,
  UnexplainedTransaction,
} from './services/writes'
export {
  attachToExplanation,
  createBill,
  deleteExplanation,
  explainTransaction,
  listUnexplainedTransactions,
} from './services/writes'

export const freeagentServer = {
  shared: freeagentShared,
  mounts: [['/api/freeagent', freeagentRouter]],
  /** `/api/hooks/<id>` is the only prefix a public mount may take — the kit's config test says so. */
  publicMounts: [['/api/hooks/freeagent', freeagentHooksRouter]],
  jobHandlers: { [FREEAGENT_SYNC_JOB]: handleFreeagentSync },
  scheduledTasks: { [FREEAGENT_CRON]: [enqueueSyncsTask] },
  agentTools: raw => freeagentAgentTools(toolCtx(raw)),
  /**
   * Additive, over this plugin's own subject. Owners and admins connect, disconnect and sync;
   * everyone may read the mirrored books (the read tools are offered to every member's runs, so
   * the page should not pretend otherwise). Writes through tools are admin-only and approved.
   */
  grants: {
    owner: can => can('manage', FREEAGENT_SUBJECT),
    admin: can => can('manage', FREEAGENT_SUBJECT),
    support: can => can('read', FREEAGENT_SUBJECT),
    member: can => can('read', FREEAGENT_SUBJECT),
  },
  /** Inert unless the analytics plugin is installed — see `cubes/index.ts`. */
  extensions: FREEAGENT_ANALYTICS_EXTENSIONS,
} satisfies ServerPlugin<typeof freeagentShared>
