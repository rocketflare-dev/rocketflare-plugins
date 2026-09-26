/**
 * Applying one page of provider items to this plugin's tables — idempotently, because both vendors
 * REPLAY: a Graph delta round may repeat items across pages, a retried job re-applies the page it
 * died on, and a full resync rewrites everything. Every write is therefore an upsert keyed on the
 * provider's immutable id, and a removal of something already gone is a no-op.
 *
 * Every row written carries the pass's `generation`; `sweep*` runs when a FULL pass completes and
 * removes what that pass did not see — the only way to learn about deletions that happened while a
 * delta token was expired. Directory rows are soft-deleted (they explain history in the status
 * view); memberships and events are simply deleted.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import {
  connectorsCalendarEvents,
  connectorsDirectoryGroups,
  connectorsDirectoryUsers,
  connectorsGroupMembers,
} from '../db/schema'
import type {
  CalendarEventItem,
  DirectoryGroupItem,
  DirectoryUserItem,
  SyncPage,
} from '../providers'

interface Scope {
  tenantId: string
  installationId: string
  generation: number
}

const excluded = (column: string) => sql.raw(`excluded.${column}`)

/**
 * A provider may repeat an id within one page (Graph does across a delta round), and Postgres
 * refuses an upsert that names the same key twice in one statement. Repeats are MERGED, later
 * fields over earlier ones, so two partial deltas for one object keep both halves.
 */
function lastById<T extends { externalId: string }>(items: readonly T[]): T[] {
  const merged = new Map<string, T>()
  for (const item of items) {
    const defined = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined))
    merged.set(item.externalId, { ...merged.get(item.externalId), ...defined } as T)
  }
  return [...merged.values()]
}

/**
 * Items grouped by WHICH optional fields they carry, so a page is still one statement per shape:
 * a full pass is a single shape (everything present); an incremental round is a handful. An
 * absent field is left out of the conflict `SET`, so a partial delta item never erases a column.
 */
function byShape<T extends object>(items: readonly T[], fields: readonly (keyof T)[]): T[][] {
  const shapes = new Map<string, T[]>()
  for (const item of items) {
    const key = fields.map(f => (item[f] === undefined ? '0' : '1')).join('')
    shapes.set(key, [...(shapes.get(key) ?? []), item])
  }
  return [...shapes.values()]
}

const USER_FIELDS = ['email', 'displayName', 'jobTitle', 'accountEnabled'] as const
const USER_COLUMNS: Record<(typeof USER_FIELDS)[number], string> = {
  email: 'email',
  displayName: 'display_name',
  jobTitle: 'job_title',
  accountEnabled: 'account_enabled',
}

export async function applyUsers(
  db: Database,
  scope: Scope,
  page: SyncPage<DirectoryUserItem>
): Promise<number> {
  const { tenantId, installationId, generation } = scope
  const items = lastById(page.items)
  for (const shape of byShape(items, USER_FIELDS)) {
    const present = USER_FIELDS.filter(f => shape[0]?.[f] !== undefined)
    await db
      .insert(connectorsDirectoryUsers)
      .values(
        shape.map(item => ({
          tenantId,
          installationId,
          externalId: item.externalId,
          email: item.email === undefined ? undefined : item.email?.trim().toLowerCase() || null,
          displayName: item.displayName,
          jobTitle: item.jobTitle,
          accountEnabled: item.accountEnabled,
          syncGeneration: generation,
        }))
      )
      .onConflictDoUpdate({
        target: [connectorsDirectoryUsers.installationId, connectorsDirectoryUsers.externalId],
        set: {
          ...Object.fromEntries(present.map(f => [f, excluded(USER_COLUMNS[f])])),
          syncGeneration: excluded('sync_generation'),
          deletedAt: sql`null`,
          updatedAt: sql`now()`,
        },
      })
  }
  if (page.removed.length > 0) {
    await db
      .update(connectorsDirectoryUsers)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(connectorsDirectoryUsers.tenantId, tenantId),
          eq(connectorsDirectoryUsers.installationId, installationId),
          inArray(connectorsDirectoryUsers.externalId, page.removed),
          isNull(connectorsDirectoryUsers.deletedAt)
        )
      )
  }
  return items.length + page.removed.length
}

const GROUP_FIELDS = ['displayName', 'email', 'description'] as const
const GROUP_COLUMNS: Record<(typeof GROUP_FIELDS)[number], string> = {
  displayName: 'display_name',
  email: 'email',
  description: 'description',
}

export async function applyGroups(
  db: Database,
  scope: Scope,
  page: SyncPage<DirectoryGroupItem>
): Promise<number> {
  const { tenantId, installationId, generation } = scope
  const items = lastById(page.items)
  for (const shape of byShape(items, GROUP_FIELDS)) {
    const present = GROUP_FIELDS.filter(f => shape[0]?.[f] !== undefined)
    await db
      .insert(connectorsDirectoryGroups)
      .values(
        shape.map(item => ({
          tenantId,
          installationId,
          externalId: item.externalId,
          displayName: item.displayName,
          email: item.email === undefined ? undefined : item.email?.trim().toLowerCase() || null,
          description: item.description,
          syncGeneration: generation,
        }))
      )
      .onConflictDoUpdate({
        target: [connectorsDirectoryGroups.installationId, connectorsDirectoryGroups.externalId],
        set: {
          ...Object.fromEntries(present.map(f => [f, excluded(GROUP_COLUMNS[f])])),
          syncGeneration: excluded('sync_generation'),
          deletedAt: sql`null`,
          updatedAt: sql`now()`,
        },
      })
  }
  for (const item of page.items) {
    // Every occurrence, in order: two partial `members@delta` for one group add up.
    const members = item.members
    if (!members) continue
    const memberScope = and(
      eq(connectorsGroupMembers.tenantId, tenantId),
      eq(connectorsGroupMembers.installationId, installationId),
      eq(connectorsGroupMembers.groupExternalId, item.externalId)
    )
    if (members.mode === 'replace') await db.delete(connectorsGroupMembers).where(memberScope)
    const added = members.mode === 'replace' ? members.userExternalIds : members.added
    if (added.length > 0) {
      await db
        .insert(connectorsGroupMembers)
        .values(
          [...new Set(added)].map(userExternalId => ({
            tenantId,
            installationId,
            groupExternalId: item.externalId,
            userExternalId,
            syncGeneration: generation,
          }))
        )
        .onConflictDoUpdate({
          target: [
            connectorsGroupMembers.installationId,
            connectorsGroupMembers.groupExternalId,
            connectorsGroupMembers.userExternalId,
          ],
          set: { syncGeneration: excluded('sync_generation') },
        })
    }
    if (members.mode === 'delta' && members.removed.length > 0) {
      await db
        .delete(connectorsGroupMembers)
        .where(and(memberScope, inArray(connectorsGroupMembers.userExternalId, members.removed)))
    }
  }
  if (page.removed.length > 0) {
    await db
      .update(connectorsDirectoryGroups)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(connectorsDirectoryGroups.tenantId, tenantId),
          eq(connectorsDirectoryGroups.installationId, installationId),
          inArray(connectorsDirectoryGroups.externalId, page.removed),
          isNull(connectorsDirectoryGroups.deletedAt)
        )
      )
    await db
      .delete(connectorsGroupMembers)
      .where(
        and(
          eq(connectorsGroupMembers.tenantId, tenantId),
          eq(connectorsGroupMembers.installationId, installationId),
          inArray(connectorsGroupMembers.groupExternalId, page.removed)
        )
      )
  }
  return items.length + page.removed.length
}

export async function applyEvents(
  db: Database,
  scope: { tenantId: string; connectionId: string; ownerUserId: string | null; generation: number },
  page: SyncPage<CalendarEventItem>
): Promise<number> {
  const { tenantId, connectionId, ownerUserId, generation } = scope
  const items = lastById(page.items)
  if (items.length > 0) {
    await db
      .insert(connectorsCalendarEvents)
      .values(
        items.map(item => ({
          tenantId,
          connectionId,
          ownerUserId,
          externalId: item.externalId,
          title: item.title,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
          isAllDay: item.isAllDay,
          location: item.location,
          organizerEmail: item.organizerEmail?.toLowerCase() ?? null,
          organizerName: item.organizerName,
          attendees: item.attendees,
          webLink: item.webLink,
          isCancelled: item.isCancelled,
          syncGeneration: generation,
        }))
      )
      .onConflictDoUpdate({
        target: [connectorsCalendarEvents.connectionId, connectorsCalendarEvents.externalId],
        set: {
          ownerUserId: excluded('owner_user_id'),
          title: excluded('title'),
          startsAt: excluded('starts_at'),
          endsAt: excluded('ends_at'),
          isAllDay: excluded('is_all_day'),
          location: excluded('location'),
          organizerEmail: excluded('organizer_email'),
          organizerName: excluded('organizer_name'),
          attendees: excluded('attendees'),
          webLink: excluded('web_link'),
          isCancelled: excluded('is_cancelled'),
          syncGeneration: excluded('sync_generation'),
          updatedAt: sql`now()`,
        },
      })
  }
  if (page.removed.length > 0) {
    await db
      .delete(connectorsCalendarEvents)
      .where(
        and(
          eq(connectorsCalendarEvents.tenantId, tenantId),
          eq(connectorsCalendarEvents.connectionId, connectionId),
          inArray(connectorsCalendarEvents.externalId, page.removed)
        )
      )
  }
  return items.length + page.removed.length
}

// ---- Sweeps, after a FULL pass --------------------------------------------------------------------

export async function sweepUsers(db: Database, scope: Scope): Promise<void> {
  await db
    .update(connectorsDirectoryUsers)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(connectorsDirectoryUsers.tenantId, scope.tenantId),
        eq(connectorsDirectoryUsers.installationId, scope.installationId),
        lt(connectorsDirectoryUsers.syncGeneration, scope.generation),
        isNull(connectorsDirectoryUsers.deletedAt)
      )
    )
}

export async function sweepGroups(db: Database, scope: Scope): Promise<void> {
  await db
    .update(connectorsDirectoryGroups)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(connectorsDirectoryGroups.tenantId, scope.tenantId),
        eq(connectorsDirectoryGroups.installationId, scope.installationId),
        lt(connectorsDirectoryGroups.syncGeneration, scope.generation),
        isNull(connectorsDirectoryGroups.deletedAt)
      )
    )
  await db
    .delete(connectorsGroupMembers)
    .where(
      and(
        eq(connectorsGroupMembers.tenantId, scope.tenantId),
        eq(connectorsGroupMembers.installationId, scope.installationId),
        lt(connectorsGroupMembers.syncGeneration, scope.generation)
      )
    )
}

export async function sweepEvents(
  db: Database,
  scope: { tenantId: string; connectionId: string; generation: number }
): Promise<void> {
  await db
    .delete(connectorsCalendarEvents)
    .where(
      and(
        eq(connectorsCalendarEvents.tenantId, scope.tenantId),
        eq(connectorsCalendarEvents.connectionId, scope.connectionId),
        lt(connectorsCalendarEvents.syncGeneration, scope.generation)
      )
    )
}
