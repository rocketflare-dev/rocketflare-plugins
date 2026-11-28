/**
 * The service API other plugins call, behind the kill switch (kit 0.48.0).
 *
 * Each function is the one in `services/`, with the same signature, wrapped in `definePublic`: it
 * answers 404 `domain_unavailable` while an admin has turned `freeagent` off for `tenantId`'s
 * organisation (Settings → Domains), and otherwise runs unchanged. This plugin's own routes, jobs
 * and tools call the unwrapped services: the host already stops those while the plugin is off.
 */
import { FREEAGENT_ID } from '@rocketflare/shared/plugins/freeagent/index'
import { type Database, definePublic } from '@/plugins/api'
import { freeagentClientFor as clientFor } from './services/connection'
import {
  attachToExplanation as attach,
  createBill as bill,
  deleteExplanation as deleteOne,
  explainTransaction as explain,
  listUnexplainedTransactions as listUnexplained,
} from './services/writes'

/**
 * `definePublic` for a service that takes `(ctx, tenantId, …)`, keeping that signature: the
 * wrapper reads the caller's `db` and the `tenantId` it names, which is the organisation the call
 * acts in.
 */
function gated<C extends { db: Database }, A extends unknown[], R>(
  fn: (ctx: C, tenantId: string, ...rest: A) => Promise<R>
): (ctx: C, tenantId: string, ...rest: A) => Promise<R> {
  const call = definePublic(
    FREEAGENT_ID,
    (caller: { db: Database; tenantId: string; ctx: C }, ...rest: A) =>
      fn(caller.ctx, caller.tenantId, ...rest)
  )
  return (ctx, tenantId, ...rest) => call({ db: ctx.db, tenantId, ctx }, ...rest) as Promise<R>
}

export const freeagentClientFor = gated(clientFor)
export const explainTransaction = gated(explain)
export const attachToExplanation = gated(attach)
export const deleteExplanation = gated(deleteOne)
export const createBill = gated(bill)
export const listUnexplainedTransactions = gated(listUnexplained)
