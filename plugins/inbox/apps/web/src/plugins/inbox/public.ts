/**
 * The readers another plugin calls (a receipts matcher, a ticketing bridge), behind the kill
 * switch (kit 0.48.0).
 *
 * Each is the reader in `services/parse.ts`, with the same signature, wrapped in `definePublic`:
 * it answers 404 `domain_unavailable` while an admin has turned `inbox` off for `tenantId`'s
 * organisation (Settings → Domains), and otherwise runs unchanged. This plugin's own routes, jobs
 * and tools call the unwrapped readers: the host already stops those while the plugin is off.
 */
import { INBOX_ID } from '@rocketflare/shared/plugins/inbox/index'
import { type Database, definePublic } from '@/plugins/api'
import { readInboxAttachment as readAttachment, readInboxHtml as readHtml } from './services/parse'

/**
 * `definePublic` for a reader that takes `(ctx, tenantId, …)`, keeping that signature: the wrapper
 * reads the caller's `db` and the `tenantId` it names, which is the organisation the call reads.
 */
function gated<C extends { db: Database }, A extends unknown[], R>(
  fn: (ctx: C, tenantId: string, ...rest: A) => Promise<R>
): (ctx: C, tenantId: string, ...rest: A) => Promise<R> {
  const call = definePublic(
    INBOX_ID,
    (caller: { db: Database; tenantId: string; ctx: C }, ...rest: A) =>
      fn(caller.ctx, caller.tenantId, ...rest)
  )
  return (ctx, tenantId, ...rest) => call({ db: ctx.db, tenantId, ctx }, ...rest) as Promise<R>
}

/** The bytes of one attachment, or null when it is gone. */
export const readInboxAttachment = gated(readAttachment)
/** The HTML body of one message, or null when it has none. */
export const readInboxHtml = gated(readHtml)
