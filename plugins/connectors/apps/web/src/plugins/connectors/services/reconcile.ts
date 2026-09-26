/**
 * Reconciling the synced directory with this organisation's MEMBERS — the step that decides whose
 * calendar is synced at all.
 *
 * **Only a directory person who is a member of this organisation is synced beyond the directory.**
 * An org-wide grant could read every mailbox in the customer tenant, and "could" is not a reason
 * to: someone who has never joined the app has no one here to show their calendar to, and copying
 * it anyway would be holding data for nobody. So a mailbox connection exists exactly while its
 * directory row is live, enabled and matched (lower-cased email) to a member — created when that
 * becomes true, deleted (with its cursor and events, by cascade) when it stops being true.
 *
 * Runs after every users pass and on every cron tick, so a person who joins the app is picked up
 * within one tick without a directory change having to happen first.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { tenantUsers, users } from '@/db/schema/kit'
import type { Database } from '@/plugins/api'
import {
  connectorsCalendarEvents,
  connectorsConnections,
  connectorsDirectoryUsers,
  connectorsSyncCursors,
} from '../db/schema'
import type { ConnectorProvider } from '../providers'

export interface ReconcileResult {
  matched: number
  /** Calendar cursors that have never run — the caller enqueues these at once. */
  newCursorIds: string[]
}

export async function reconcileInstallation(
  db: Database,
  tenantId: string,
  installationId: string,
  provider: ConnectorProvider
): Promise<ReconcileResult> {
  // 1. Match live directory rows to members of THIS organisation by lower-cased email.
  await db
    .update(connectorsDirectoryUsers)
    .set({
      matchedUserId: sql`(
        select ${users.id} from ${users}
        join ${tenantUsers} on ${tenantUsers.userId} = ${users.id}
          and ${tenantUsers.tenantId} = ${tenantId}
        where lower(${users.email}) = ${connectorsDirectoryUsers.email}
        limit 1
      )`,
    })
    .where(
      and(
        eq(connectorsDirectoryUsers.tenantId, tenantId),
        eq(connectorsDirectoryUsers.installationId, installationId),
        isNull(connectorsDirectoryUsers.deletedAt)
      )
    )
  await db
    .update(connectorsDirectoryUsers)
    .set({ matchedUserId: null })
    .where(
      and(
        eq(connectorsDirectoryUsers.tenantId, tenantId),
        eq(connectorsDirectoryUsers.installationId, installationId),
        sql`${connectorsDirectoryUsers.deletedAt} is not null`
      )
    )
  const [{ matched } = { matched: 0 }] = await db
    .select({ matched: sql<number>`count(*)::int` })
    .from(connectorsDirectoryUsers)
    .where(
      and(
        eq(connectorsDirectoryUsers.tenantId, tenantId),
        eq(connectorsDirectoryUsers.installationId, installationId),
        sql`${connectorsDirectoryUsers.matchedUserId} is not null`
      )
    )

  // 2. Mailboxes that no longer qualify go, taking their cursor and events with them.
  const eligible = sql`(
    ${connectorsDirectoryUsers.deletedAt} is null
    and ${connectorsDirectoryUsers.accountEnabled}
    and ${connectorsDirectoryUsers.matchedUserId} is not null
  )`
  await db.delete(connectorsConnections).where(
    and(
      eq(connectorsConnections.tenantId, tenantId),
      eq(connectorsConnections.installationId, installationId),
      eq(connectorsConnections.ownerType, 'tenant'),
      sql`${connectorsConnections.directoryUserId} is not null`,
      sql`not exists (
          select 1 from ${connectorsDirectoryUsers}
          where ${connectorsDirectoryUsers.id} = ${connectorsConnections.directoryUserId}
            and ${connectorsDirectoryUsers.tenantId} = ${tenantId}
            and ${eligible}
        )`
    )
  )
  if (!provider.calendar) return { matched: Number(matched), newCursorIds: [] }

  // 3. Every qualifying mailbox has a connection and a calendar cursor.
  const authKind = provider.tokenPerSubject ? ('dwd' as const) : ('app_only' as const)
  const people = await db
    .select({ id: connectorsDirectoryUsers.id, externalId: connectorsDirectoryUsers.externalId })
    .from(connectorsDirectoryUsers)
    .where(
      and(
        eq(connectorsDirectoryUsers.tenantId, tenantId),
        eq(connectorsDirectoryUsers.installationId, installationId),
        eligible
      )
    )
  if (people.length > 0) {
    await db
      .insert(connectorsConnections)
      .values(
        people.map(p => ({
          tenantId,
          installationId,
          ownerType: 'tenant' as const,
          authKind,
          subject: p.externalId,
          directoryUserId: p.id,
        }))
      )
      .onConflictDoNothing()
  }
  const mailboxes = await db
    .select({ id: connectorsConnections.id })
    .from(connectorsConnections)
    .where(
      and(
        eq(connectorsConnections.tenantId, tenantId),
        eq(connectorsConnections.installationId, installationId),
        sql`${connectorsConnections.directoryUserId} is not null`
      )
    )
  if (mailboxes.length === 0) return { matched: Number(matched), newCursorIds: [] }
  const created = await db
    .insert(connectorsSyncCursors)
    .values(mailboxes.map(m => ({ tenantId, connectionId: m.id, resource: 'calendar' })))
    .onConflictDoNothing()
    .returning({ id: connectorsSyncCursors.id })

  // 4. A mailbox whose owner changed (their directory email now names another member) re-homes
  //    its events, so they are never visible to the previous owner.
  await db
    .update(connectorsCalendarEvents)
    .set({
      ownerUserId: sql`(
        select ${connectorsDirectoryUsers.matchedUserId}
        from ${connectorsConnections}
        join ${connectorsDirectoryUsers}
          on ${connectorsDirectoryUsers.id} = ${connectorsConnections.directoryUserId}
        where ${connectorsConnections.id} = ${connectorsCalendarEvents.connectionId}
      )`,
    })
    .where(
      and(
        eq(connectorsCalendarEvents.tenantId, tenantId),
        sql`${connectorsCalendarEvents.connectionId} in (
          select ${connectorsConnections.id} from ${connectorsConnections}
          join ${connectorsDirectoryUsers}
            on ${connectorsDirectoryUsers.id} = ${connectorsConnections.directoryUserId}
          where ${connectorsConnections.installationId} = ${installationId}
            and ${connectorsConnections.tenantId} = ${tenantId}
            and ${connectorsDirectoryUsers.matchedUserId}
              is distinct from ${connectorsCalendarEvents.ownerUserId}
        )`
      )
    )
  return { matched: Number(matched), newCursorIds: created.map(c => c.id) }
}
