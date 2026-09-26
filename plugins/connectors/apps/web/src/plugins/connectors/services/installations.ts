/**
 * Installations: start the consent round trip, complete it, read the status, disconnect.
 *
 * Every function takes the tenant id it is told and filters by it — the route hands over
 * `ctx.tenantId`, the public callback the tenant id inside a VERIFIED signed state, the job the
 * tenant id in its payload. Nothing here reads a tenant from anywhere else.
 */
import type {
  AppMode,
  ConnectorInstallation,
  ConnectorResource,
  SyncCursorStatus,
} from '@rocketflare/shared/plugins/connectors/index'
import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Database, PluginConfig } from '@/plugins/api'
import { openSecret, sealSecret, transaction } from '@/plugins/api'
import {
  CONNECTORS_ORGANISATION_SUBJECT,
  type ConnectorsConnectionRow,
  type ConnectorsInstallationRow,
  connectorsCalendarEvents,
  connectorsConnections,
  connectorsDirectoryGroups,
  connectorsDirectoryUsers,
  connectorsInstallations,
  connectorsSyncCursors,
} from '../db/schema'
import type { ConnectorCredentials, ConnectorProvider, InstallationView } from '../providers'

export async function loadInstallation(
  db: Database,
  tenantId: string,
  installationId: string
): Promise<ConnectorsInstallationRow | undefined> {
  const [row] = await db
    .select()
    .from(connectorsInstallations)
    .where(
      and(
        eq(connectorsInstallations.id, installationId),
        eq(connectorsInstallations.tenantId, tenantId)
      )
    )
    .limit(1)
  return row
}

export function toInstallationView(row: ConnectorsInstallationRow): InstallationView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    externalTenantId: row.externalTenantId,
    appMode: row.appMode,
    settings: row.settings,
  }
}

/**
 * The credentials an installation authenticates with, unsealed at the moment of use: the
 * organisation's own app for `byo`, the deployment's for `operator`. Null when neither exists —
 * the operator never registered the app, or a BYO row lost its secret.
 */
export async function credentialsFor(
  config: PluginConfig,
  provider: ConnectorProvider,
  row: Pick<ConnectorsInstallationRow, 'appMode' | 'byoClientId' | 'byoSecretEnc'>
): Promise<ConnectorCredentials | null> {
  if (row.appMode === 'byo') {
    if (!row.byoClientId || !row.byoSecretEnc) return null
    return { clientId: row.byoClientId, clientSecret: await openSecret(config, row.byoSecretEnc) }
  }
  return provider.operatorCredentials(config)
}

export interface StartInstallationInput {
  tenantId: string
  userId: string
  provider: string
  appMode: AppMode
  clientId?: string
  clientSecret?: string
}

/**
 * Create the installation row (or reuse the organisation's existing one for this provider) as the
 * anchor the signed state points at. Re-running consent on an ACTIVE installation keeps it active
 * — the admin is re-granting, perhaps with more permissions, and the sync must not stop meanwhile.
 * Switching app mode replaces the stored BYO credentials; switching to `operator` clears them.
 */
export async function upsertPendingInstallation(
  db: Database,
  config: PluginConfig,
  input: StartInstallationInput
): Promise<ConnectorsInstallationRow> {
  const byo =
    input.appMode === 'byo' && input.clientId && input.clientSecret
      ? {
          byoClientId: input.clientId,
          byoSecretEnc: await sealSecret(config, input.clientSecret),
        }
      : { byoClientId: null, byoSecretEnc: null }
  const [row] = await db
    .insert(connectorsInstallations)
    .values({
      tenantId: input.tenantId,
      provider: input.provider,
      appMode: input.appMode,
      installedByUserId: input.userId,
      ...byo,
    })
    .onConflictDoUpdate({
      target: [connectorsInstallations.tenantId, connectorsInstallations.provider],
      set: { appMode: input.appMode, installedByUserId: input.userId, ...byo },
    })
    .returning()
  if (!row) throw new Error('connectors_installations: upsert returned no row')
  return row
}

/**
 * Consent came back. Record who we are connected to, turn the installation on, and make sure the
 * organisation's own connection and its directory cursors exist. Idempotent: a second callback
 * (a browser back-button replay within the state's lifetime) changes nothing but timestamps.
 *
 * A DIFFERENT external tenant on an already-active installation is refused rather than silently
 * re-pointed: every synced row belongs to the first one, and mixing two directories under one
 * installation is not a state this model can represent.
 */
export async function activateInstallation(
  db: Database,
  tenantId: string,
  installationId: string,
  consent: { externalTenantId: string; displayName?: string | null },
  authKind: 'app_only' | 'dwd'
): Promise<{ installation: ConnectorsInstallationRow; cursorIds: string[] }> {
  return transaction(db, async tx => {
    const [current] = await tx
      .select()
      .from(connectorsInstallations)
      .where(
        and(
          eq(connectorsInstallations.id, installationId),
          eq(connectorsInstallations.tenantId, tenantId)
        )
      )
      .for('update')
    if (!current) throw new Error('installation not found')
    if (current.externalTenantId && current.externalTenantId !== consent.externalTenantId) {
      throw new ExternalTenantMismatchError()
    }
    const [installation] = await tx
      .update(connectorsInstallations)
      .set({
        status: 'active',
        externalTenantId: consent.externalTenantId,
        displayName: consent.displayName ?? current.displayName,
        installedAt: current.installedAt ?? new Date(),
        lastError: null,
        lastErrorAt: null,
      })
      .where(
        and(
          eq(connectorsInstallations.id, installationId),
          eq(connectorsInstallations.tenantId, tenantId)
        )
      )
      .returning()
    if (!installation) throw new Error('installation not found')
    const [org] = await tx
      .insert(connectorsConnections)
      .values({
        tenantId,
        installationId,
        ownerType: 'tenant',
        authKind,
        subject: CONNECTORS_ORGANISATION_SUBJECT,
      })
      .onConflictDoUpdate({
        target: [
          connectorsConnections.installationId,
          connectorsConnections.ownerType,
          connectorsConnections.subject,
        ],
        set: { status: 'active', lastError: null },
      })
      .returning()
    if (!org) throw new Error('connectors_connections: upsert returned no row')
    const cursors = await ensureCursors(tx, tenantId, org.id, ['users', 'groups'])
    return { installation, cursorIds: cursors }
  })
}

export class ExternalTenantMismatchError extends Error {
  constructor() {
    super('This installation is already connected to a different organisation')
    this.name = 'ExternalTenantMismatchError'
  }
}

/** Create the cursors that do not exist yet; answer the ids of every one asked for. */
export async function ensureCursors(
  db: Database,
  tenantId: string,
  connectionId: string,
  resources: readonly ConnectorResource[]
): Promise<string[]> {
  if (resources.length === 0) return []
  await db
    .insert(connectorsSyncCursors)
    .values(resources.map(resource => ({ tenantId, connectionId, resource })))
    .onConflictDoNothing()
  const rows = await db
    .select({ id: connectorsSyncCursors.id, resource: connectorsSyncCursors.resource })
    .from(connectorsSyncCursors)
    .where(
      and(
        eq(connectorsSyncCursors.tenantId, tenantId),
        eq(connectorsSyncCursors.connectionId, connectionId)
      )
    )
  return rows.filter(r => (resources as readonly string[]).includes(r.resource)).map(r => r.id)
}

/** The organisation-level connection of an installation (created on activation). */
export async function organisationConnection(
  db: Database,
  tenantId: string,
  installationId: string
): Promise<ConnectorsConnectionRow | undefined> {
  const [row] = await db
    .select()
    .from(connectorsConnections)
    .where(
      and(
        eq(connectorsConnections.tenantId, tenantId),
        eq(connectorsConnections.installationId, installationId),
        eq(connectorsConnections.ownerType, 'tenant'),
        eq(connectorsConnections.subject, CONNECTORS_ORGANISATION_SUBJECT)
      )
    )
    .limit(1)
  return row
}

/** Mark the installation broken, with a reason an admin can act on. Never throws. */
export async function markInstallationError(
  db: Database,
  tenantId: string,
  installationId: string,
  message: string
): Promise<void> {
  await db
    .update(connectorsInstallations)
    .set({ status: 'error', lastError: message.slice(0, 500), lastErrorAt: new Date() })
    .where(
      and(
        eq(connectorsInstallations.id, installationId),
        eq(connectorsInstallations.tenantId, tenantId)
      )
    )
    .catch(() => {})
}

/** An admin's retry of an `error` installation. The next sync's token mint is the real test. */
export async function reactivateInstallation(
  db: Database,
  tenantId: string,
  installationId: string
): Promise<void> {
  await db
    .update(connectorsInstallations)
    .set({ status: 'active' })
    .where(
      and(
        eq(connectorsInstallations.id, installationId),
        eq(connectorsInstallations.tenantId, tenantId),
        eq(connectorsInstallations.status, 'error')
      )
    )
}

/**
 * Disconnect: delete the installation, and with it — by cascade — every connection, cursor,
 * directory row, membership and calendar event it produced. Answers false when there was nothing
 * to delete. Revoking the app on the VENDOR side is the admin's own act (Entra → Enterprise
 * applications, Google Admin → API controls); the UI says so.
 */
export async function deleteInstallation(
  db: Database,
  tenantId: string,
  installationId: string
): Promise<ConnectorsInstallationRow | undefined> {
  const [row] = await db
    .delete(connectorsInstallations)
    .where(
      and(
        eq(connectorsInstallations.id, installationId),
        eq(connectorsInstallations.tenantId, tenantId)
      )
    )
    .returning()
  return row
}

// ---- The status view -----------------------------------------------------------------------------

async function countsFor(db: Database, tenantId: string, installationId: string) {
  const [users] = await db
    .select({
      total: count(),
      matched: sql<number>`count(${connectorsDirectoryUsers.matchedUserId})::int`,
    })
    .from(connectorsDirectoryUsers)
    .where(
      and(
        eq(connectorsDirectoryUsers.tenantId, tenantId),
        eq(connectorsDirectoryUsers.installationId, installationId),
        isNull(connectorsDirectoryUsers.deletedAt)
      )
    )
  const [groups] = await db
    .select({ total: count() })
    .from(connectorsDirectoryGroups)
    .where(
      and(
        eq(connectorsDirectoryGroups.tenantId, tenantId),
        eq(connectorsDirectoryGroups.installationId, installationId),
        isNull(connectorsDirectoryGroups.deletedAt)
      )
    )
  const [mailboxes] = await db
    .select({ total: count() })
    .from(connectorsConnections)
    .where(
      and(
        eq(connectorsConnections.tenantId, tenantId),
        eq(connectorsConnections.installationId, installationId),
        isNotNull(connectorsConnections.directoryUserId)
      )
    )
  const [events] = await db
    .select({ total: count() })
    .from(connectorsCalendarEvents)
    .innerJoin(
      connectorsConnections,
      eq(connectorsConnections.id, connectorsCalendarEvents.connectionId)
    )
    .where(
      and(
        eq(connectorsCalendarEvents.tenantId, tenantId),
        eq(connectorsConnections.installationId, installationId)
      )
    )
  return {
    users: Number(users?.total ?? 0),
    matchedUsers: Number(users?.matched ?? 0),
    groups: Number(groups?.total ?? 0),
    mailboxes: Number(mailboxes?.total ?? 0),
    events: Number(events?.total ?? 0),
  }
}

async function cursorStatusFor(
  db: Database,
  tenantId: string,
  installationId: string
): Promise<SyncCursorStatus[]> {
  const rows = await db
    .select({
      resource: connectorsSyncCursors.resource,
      count: count(),
      backfilling: sql<number>`count(*) filter (where ${connectorsSyncCursors.inProgress} or ${connectorsSyncCursors.lastSyncedAt} is null)::int`,
      lastSyncedAt: sql<Date | null>`max(${connectorsSyncCursors.lastSyncedAt})`,
      failing: sql<number>`count(${connectorsSyncCursors.lastError})::int`,
      lastError: sql<
        string | null
      >`(array_agg(${connectorsSyncCursors.lastError} order by ${connectorsSyncCursors.lastErrorAt} desc nulls last))[1]`,
    })
    .from(connectorsSyncCursors)
    .innerJoin(
      connectorsConnections,
      eq(connectorsConnections.id, connectorsSyncCursors.connectionId)
    )
    .where(
      and(
        eq(connectorsSyncCursors.tenantId, tenantId),
        eq(connectorsConnections.installationId, installationId)
      )
    )
    .groupBy(connectorsSyncCursors.resource)
    .orderBy(connectorsSyncCursors.resource)
  return rows.map(r => ({
    resource: r.resource as ConnectorResource,
    count: Number(r.count),
    backfilling: Number(r.backfilling),
    lastSyncedAt: r.lastSyncedAt ? new Date(r.lastSyncedAt) : null,
    failing: Number(r.failing),
    lastError: r.lastError,
  }))
}

/** The public shape. `hasCredential` for a BYO secret, never the value. */
export async function toInstallation(
  db: Database,
  row: ConnectorsInstallationRow
): Promise<ConnectorInstallation> {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    appMode: row.appMode,
    hasCredential: Boolean(row.byoSecretEnc),
    externalTenantId: row.externalTenantId,
    displayName: row.displayName,
    grantedScopes: row.grantedScopes,
    installedAt: row.installedAt,
    lastError: row.lastError,
    counts: await countsFor(db, row.tenantId, row.id),
    cursors: await cursorStatusFor(db, row.tenantId, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listInstallations(
  db: Database,
  tenantId: string
): Promise<ConnectorInstallation[]> {
  const rows = await db
    .select()
    .from(connectorsInstallations)
    .where(eq(connectorsInstallations.tenantId, tenantId))
    .orderBy(connectorsInstallations.provider)
  return Promise.all(rows.map(row => toInstallation(db, row)))
}
