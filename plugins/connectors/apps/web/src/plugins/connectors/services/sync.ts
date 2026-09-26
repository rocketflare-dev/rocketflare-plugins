/**
 * The sync engine: advance ONE cursor by up to `MAX_PAGES_PER_JOB` pages, for any provider.
 *
 * The shape of one run:
 *
 *   load cursor + connection + installation (tenant from the payload) → skip unless active
 *   → CLAIM the cursor (one conditional UPDATE; a second job for it acks and leaves)
 *   → start a FULL pass if there is no cursor, or the provider says the chain is too old
 *   → page: provider turns cursor → items; `apply*` upserts them; the cursor is saved after EVERY
 *     page, so a job that dies resumes where it stopped rather than starting over
 *   → `final` ends the pass: store the delta token, sweep what a full pass did not see
 *   → release the claim; more pages than one job may take → enqueue the continuation.
 *
 * Failure mapping — each outcome is a DIFFERENT instruction to the queue:
 *
 * - `CursorExpiredError` → reset for a full pass and continue now (not a failure).
 * - `RetryLaterError`    → release, re-enqueue after `Retry-After`, ack (throttling is normal).
 * - `ConnectorAuthError` → installation `error`, ack (retrying cannot fix a revoked consent).
 * - anything else        → record on the cursor, release, THROW so the queue retries with backoff.
 */
import { CONNECTORS_SYNC_JOB } from '@rocketflare/shared/plugins/connectors/index'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database, JobCtx, JobInput, PluginLogger } from '@/plugins/api'
import {
  CONNECTORS_ORGANISATION_SUBJECT,
  type ConnectorsConnectionRow,
  type ConnectorsInstallationRow,
  type ConnectorsSyncCursorRow,
  connectorsConnections,
  connectorsDirectoryUsers,
  connectorsInstallations,
  connectorsSyncCursors,
} from '../db/schema'
import {
  ConnectorAuthError,
  type ConnectorProvider,
  CursorExpiredError,
  connectorProvider,
  type FetchLike,
  RetryLaterError,
  type SourceCtx,
  type SubjectView,
  type SyncPage,
} from '../providers'
import { applyEvents, applyGroups, applyUsers, sweepEvents, sweepGroups, sweepUsers } from './apply'
import { markInstallationError, organisationConnection, toInstallationView } from './installations'
import { reconcileInstallation } from './reconcile'
import { accessToken } from './tokens'

/** Pages one job may take before it hands over to a continuation (keeps a message well inside limits). */
export const MAX_PAGES_PER_JOB = 10
/** How long a claim holds. Longer than any one job; short enough that a crash self-heals. */
export const CLAIM_MS = 10 * 60_000
/** A throttled job never waits less than this, whatever `Retry-After` said. */
const MIN_RETRY_SECONDS = 5
/** …nor more than a Queue delay allows. */
const MAX_RETRY_SECONDS = 12 * 60 * 60

export interface SyncDeps {
  fetch: FetchLike
  now?: () => Date
}

/** Unbound `fetch` throws "Illegal invocation" on Workers once it is called as a method. */
export const defaultSyncDeps: SyncDeps = { fetch: (input, init) => fetch(input, init) }

export type SyncOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'done'; items: number; pages: number }
  | { kind: 'continued'; items: number; pages: number }
  | { kind: 'reset' }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'auth_failed'; message: string }

interface Loaded {
  cursor: ConnectorsSyncCursorRow
  connection: ConnectorsConnectionRow
  installation: ConnectorsInstallationRow
  provider: ConnectorProvider
}

async function load(db: Database, tenantId: string, cursorId: string): Promise<Loaded | string> {
  const [row] = await db
    .select({
      cursor: connectorsSyncCursors,
      connection: connectorsConnections,
      installation: connectorsInstallations,
    })
    .from(connectorsSyncCursors)
    .innerJoin(
      connectorsConnections,
      eq(connectorsConnections.id, connectorsSyncCursors.connectionId)
    )
    .innerJoin(
      connectorsInstallations,
      eq(connectorsInstallations.id, connectorsConnections.installationId)
    )
    .where(
      and(eq(connectorsSyncCursors.id, cursorId), eq(connectorsSyncCursors.tenantId, tenantId))
    )
    .limit(1)
  if (!row) return 'cursor not found (disconnected since the job was enqueued)'
  if (row.installation.status !== 'active') return `installation is ${row.installation.status}`
  const provider = connectorProvider(row.installation.provider)
  if (!provider) return `no installed plugin provides "${row.installation.provider}"`
  return { ...row, provider }
}

/** One conditional UPDATE: the claim is ours, or somebody else's and we leave. */
async function claim(
  db: Database,
  cursor: ConnectorsSyncCursorRow,
  now: Date
): Promise<string | null> {
  const token = crypto.randomUUID()
  const [row] = await db
    .update(connectorsSyncCursors)
    .set({ claimedUntil: new Date(now.getTime() + CLAIM_MS), claimToken: token })
    .where(
      and(
        eq(connectorsSyncCursors.id, cursor.id),
        eq(connectorsSyncCursors.tenantId, cursor.tenantId),
        or(isNull(connectorsSyncCursors.claimedUntil), lt(connectorsSyncCursors.claimedUntil, now))
      )
    )
    .returning({ id: connectorsSyncCursors.id })
  return row ? token : null
}

async function saveCursor(
  db: Database,
  cursor: ConnectorsSyncCursorRow,
  token: string,
  patch: Partial<typeof connectorsSyncCursors.$inferInsert>
): Promise<void> {
  await db
    .update(connectorsSyncCursors)
    .set(patch)
    .where(
      and(
        eq(connectorsSyncCursors.id, cursor.id),
        eq(connectorsSyncCursors.tenantId, cursor.tenantId),
        eq(connectorsSyncCursors.claimToken, token)
      )
    )
}

const release = { claimedUntil: null, claimToken: null } as const

/** Who a mailbox cursor reads, from its directory row. */
async function subjectOf(
  db: Database,
  connection: ConnectorsConnectionRow
): Promise<(SubjectView & { ownerUserId: string | null }) | null> {
  if (connection.subject === CONNECTORS_ORGANISATION_SUBJECT || !connection.directoryUserId) {
    return null
  }
  const [person] = await db
    .select({
      externalId: connectorsDirectoryUsers.externalId,
      email: connectorsDirectoryUsers.email,
      ownerUserId: connectorsDirectoryUsers.matchedUserId,
    })
    .from(connectorsDirectoryUsers)
    .where(
      and(
        eq(connectorsDirectoryUsers.id, connection.directoryUserId),
        eq(connectorsDirectoryUsers.tenantId, connection.tenantId)
      )
    )
    .limit(1)
  return person ?? null
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000)
}

/**
 * Advance one cursor. Answers what happened rather than throwing for the expected outcomes — only
 * an UNEXPECTED failure throws, and that throw is the queue's cue to retry.
 */
export async function runSync(
  ctx: Pick<JobCtx, 'db' | 'config' | 'logger' | 'enqueue'>,
  payload: { tenantId: string; cursorId: string },
  deps: SyncDeps = defaultSyncDeps
): Promise<SyncOutcome> {
  const { db, config, logger } = ctx
  const now = deps.now?.() ?? new Date()
  const loaded = await load(db, payload.tenantId, payload.cursorId)
  if (typeof loaded === 'string') return { kind: 'skipped', reason: loaded }
  const { connection, installation, provider } = loaded
  let cursor = loaded.cursor

  const token = await claim(db, cursor, now)
  if (!token) return { kind: 'skipped', reason: 'another job holds this cursor' }

  const continuation = (delaySeconds?: number) =>
    ctx.enqueue(
      {
        type: CONNECTORS_SYNC_JOB,
        payload: { tenantId: payload.tenantId, cursorId: payload.cursorId },
      },
      delaySeconds ? { delaySeconds } : undefined
    )

  try {
    const subject = await subjectOf(db, connection)
    const resource = cursor.resource
    if (resource === 'calendar' && (!provider.calendar || !subject)) {
      await saveCursor(db, cursor, token, release)
      return { kind: 'skipped', reason: 'calendar is not synced for this connection' }
    }

    // A chain that is too old (calendar windows) restarts as a full pass with a fresh window.
    const maxChainDays = resource === 'calendar' ? provider.calendar?.maxChainDays : undefined
    const chainExpired =
      maxChainDays !== undefined &&
      cursor.fullSyncAt !== null &&
      cursor.fullSyncAt < daysAgo(now, maxChainDays)
    if (chainExpired || (cursor.cursor === null && !cursor.inProgress)) {
      const patch = {
        cursor: null,
        inProgress: true,
        fullPass: true,
        generation: cursor.generation + 1,
        fullSyncAt: now,
      }
      await saveCursor(db, cursor, token, patch)
      cursor = { ...cursor, ...patch }
    }

    const cacheOn = provider.tokenPerSubject
      ? connection
      : ((await organisationConnection(db, connection.tenantId, installation.id)) ?? connection)
    const sourceCtx: SourceCtx = {
      installation: toInstallationView(installation),
      token: () =>
        accessToken(
          db,
          config,
          {
            provider,
            installation,
            cacheOn,
            subject: provider.tokenPerSubject ? subject : null,
          },
          deps.fetch
        ),
      fetch: deps.fetch,
      logger,
    }
    const window = {
      start: daysAgo(cursor.fullSyncAt ?? now, provider.calendar?.windowDays.past ?? 0),
      end: daysAgo(cursor.fullSyncAt ?? now, -(provider.calendar?.windowDays.future ?? 0)),
    }
    const scope = {
      tenantId: connection.tenantId,
      installationId: installation.id,
      generation: cursor.generation,
    }

    let items = 0
    for (let pages = 1; pages <= MAX_PAGES_PER_JOB; pages++) {
      let page: SyncPage<unknown>
      if (resource === 'users') {
        const p = await provider.directory.users(sourceCtx, cursor.cursor)
        items += await applyUsers(db, scope, p)
        page = p
      } else if (resource === 'groups') {
        const p = await provider.directory.groups(sourceCtx, cursor.cursor)
        items += await applyGroups(db, scope, p)
        page = p
      } else if (resource === 'calendar' && provider.calendar && subject) {
        const p = await provider.calendar.events({ ...sourceCtx, subject, window }, cursor.cursor)
        items += await applyEvents(
          db,
          {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            ownerUserId: subject.ownerUserId,
            generation: cursor.generation,
          },
          p
        )
        page = p
      } else {
        await saveCursor(db, cursor, token, release)
        return { kind: 'skipped', reason: `unknown resource "${resource}"` }
      }

      if (page.final !== null || page.next === null) {
        // The pass is over. Only a FULL pass may sweep: an incremental one saw only changes.
        if (cursor.fullPass) {
          if (resource === 'users') await sweepUsers(db, scope)
          if (resource === 'groups') await sweepGroups(db, scope)
          if (resource === 'calendar') {
            await sweepEvents(db, { ...scope, connectionId: connection.id })
          }
        }
        await saveCursor(db, cursor, token, {
          cursor: page.final,
          inProgress: false,
          fullPass: false,
          lastSyncedAt: now,
          itemsSynced: cursor.itemsSynced + items,
          lastError: null,
          lastErrorAt: null,
          ...release,
        })
        if (resource === 'users') {
          const { newCursorIds } = await reconcileInstallation(
            db,
            connection.tenantId,
            installation.id,
            provider
          )
          await enqueueCursors(ctx, connection.tenantId, newCursorIds)
        }
        return { kind: 'done', items, pages }
      }
      await saveCursor(db, cursor, token, {
        cursor: page.next,
        inProgress: true,
        itemsSynced: cursor.itemsSynced + items,
      })
      cursor = { ...cursor, cursor: page.next, inProgress: true }
    }
    await saveCursor(db, cursor, token, { ...release, itemsSynced: cursor.itemsSynced + items })
    await continuation()
    return { kind: 'continued', items, pages: MAX_PAGES_PER_JOB }
  } catch (err) {
    return handleFailure(db, logger, cursor, token, installation, err, continuation)
  }
}

async function handleFailure(
  db: Database,
  logger: PluginLogger,
  cursor: ConnectorsSyncCursorRow,
  token: string,
  installation: ConnectorsInstallationRow,
  err: unknown,
  continuation: (delaySeconds?: number) => Promise<unknown>
): Promise<SyncOutcome> {
  if (err instanceof CursorExpiredError) {
    await saveCursor(db, cursor, token, { cursor: null, inProgress: false, ...release })
    await continuation()
    return { kind: 'reset' }
  }
  if (err instanceof RetryLaterError) {
    const retryAfterSeconds = Math.min(
      MAX_RETRY_SECONDS,
      Math.max(MIN_RETRY_SECONDS, Math.ceil(err.retryAfterSeconds))
    )
    await saveCursor(db, cursor, token, release)
    await continuation(retryAfterSeconds)
    return { kind: 'throttled', retryAfterSeconds }
  }
  const message = redact(err instanceof Error ? err.message : String(err))
  if (err instanceof ConnectorAuthError) {
    await markInstallationError(db, cursor.tenantId, installation.id, message)
    await saveCursor(db, cursor, token, { lastError: message, lastErrorAt: new Date(), ...release })
    logger.warn({ installationId: installation.id, code: err.code }, 'connectors.sync: auth failed')
    return { kind: 'auth_failed', message }
  }
  await saveCursor(db, cursor, token, { lastError: message, lastErrorAt: new Date(), ...release })
  throw err
}

/** A vendor's error text can echo a token or secret back; strip anything that looks like one. */
export function redact(message: string): string {
  return message
    .replace(/(bearer\s+)[\w.~+/=-]+/gi, '$1[redacted]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]')
    .replace(/(client_secret=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 500)
}

/** Enqueue one sync per cursor id. */
export async function enqueueCursors(
  ctx: Pick<JobCtx, 'enqueue'> & { enqueueMany?: JobCtx['enqueueMany'] },
  tenantId: string,
  cursorIds: readonly string[]
): Promise<void> {
  if (cursorIds.length === 0) return
  const jobs: JobInput[] = cursorIds.map(cursorId => ({
    type: CONNECTORS_SYNC_JOB,
    payload: { tenantId, cursorId },
  }))
  if (ctx.enqueueMany) await ctx.enqueueMany(jobs)
  else for (const job of jobs) await ctx.enqueue(job)
}

/** Every cursor of an installation (optionally one resource) — what "Sync now" enqueues. */
export async function installationCursorIds(
  db: Database,
  tenantId: string,
  installationId: string,
  resource?: string
): Promise<string[]> {
  const rows = await db
    .select({ id: connectorsSyncCursors.id })
    .from(connectorsSyncCursors)
    .innerJoin(
      connectorsConnections,
      eq(connectorsConnections.id, connectorsSyncCursors.connectionId)
    )
    .where(
      and(
        eq(connectorsSyncCursors.tenantId, tenantId),
        eq(connectorsConnections.installationId, installationId),
        resource ? eq(connectorsSyncCursors.resource, resource) : sql`true`
      )
    )
  return rows.map(r => r.id)
}
