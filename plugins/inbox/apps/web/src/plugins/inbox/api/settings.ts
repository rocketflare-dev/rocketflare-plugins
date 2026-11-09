/**
 * `inbox_settings`: read, shape and upsert one organisation's row. The local part is unique across
 * tenants (it is how a message finds its organisation), so a taken one is a 409 at the route rather
 * than a raw unique violation — and it stays with its organisation for a holding period after it
 * is given up, because mail keeps arriving at an address for a while (`inbox_local_part_holds`).
 */
import {
  INBOX_CONFIRMATION_WINDOW_HOURS,
  INBOX_LOCAL_PART_HOLD_DAYS,
  type InboxSettings,
  type UpdateInboxSettings,
} from '@rocketflare/shared/plugins/inbox/index'
import { and, eq, isNull, lte, notExists, or } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import { type InboxSettingsRow, inboxLocalPartHolds, inboxSettings } from '../db/schema'

export async function loadSettings(
  db: Database,
  tenantId: string
): Promise<InboxSettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(inboxSettings)
    .where(eq(inboxSettings.tenantId, tenantId))
    .limit(1)
  return row
}

export function toSettings(row: InboxSettingsRow | undefined): InboxSettings {
  return {
    enabled: row?.enabled ?? false,
    localPart: row?.localPart ?? null,
    allowedSenders: row?.allowedSenders ?? [],
    requireAuthentication: row?.requireAuthentication ?? true,
    ingestToKnowledge: row?.ingestToKnowledge ?? true,
    confirmationWindowUntil: row?.confirmationWindowUntil ?? null,
    updatedAt: row?.updatedAt ?? null,
  }
}

/** Another organisation holds this local part, or held it inside the holding period. */
export class LocalPartHeldError extends Error {}

const holds = inboxLocalPartHolds

/**
 * Take a local part for this organisation, or throw. The claim is one upsert, decided by the
 * registry row: its conditional update fails unless this organisation holds the part, or the part
 * was released long enough ago. A row left by an organisation that is gone starts its holding
 * period at the first attempt that finds it free (a deleted tenant leaves no moment of release).
 */
async function claimLocalPart(db: Database, localPart: string, tenantId: string, now: Date) {
  const cutoff = new Date(now.getTime() - INBOX_LOCAL_PART_HOLD_DAYS * 86_400_000)
  const claimed = await db
    .insert(holds)
    .values({ localPart, holderTenantId: tenantId, releasedAt: null })
    .onConflictDoUpdate({
      target: holds.localPart,
      set: { holderTenantId: tenantId, releasedAt: null, updatedAt: now },
      setWhere: or(eq(holds.holderTenantId, tenantId), lte(holds.releasedAt, cutoff)),
    })
    .returning({ localPart: holds.localPart })
  if (claimed.length > 0) return

  await db
    .update(holds)
    .set({ releasedAt: now, updatedAt: now })
    .where(
      and(
        eq(holds.localPart, localPart),
        isNull(holds.releasedAt),
        notExists(
          db
            .select({ id: inboxSettings.id })
            .from(inboxSettings)
            .where(
              and(
                eq(inboxSettings.tenantId, holds.holderTenantId),
                eq(inboxSettings.localPart, localPart)
              )
            )
        )
      )
    )
  throw new LocalPartHeldError(localPart)
}

/** Start the holding period on the local part this organisation just gave up. */
async function releaseLocalPart(db: Database, localPart: string, tenantId: string, now: Date) {
  await db
    .insert(holds)
    .values({ localPart, holderTenantId: tenantId, releasedAt: now })
    .onConflictDoUpdate({
      target: holds.localPart,
      set: { releasedAt: now, updatedAt: now },
      setWhere: eq(holds.holderTenantId, tenantId),
    })
}

export async function saveSettings(
  db: Database,
  tenantId: string,
  userId: string | null,
  body: UpdateInboxSettings,
  now = new Date()
): Promise<InboxSettingsRow> {
  return db.transaction(async tx => {
    const current = await loadSettings(tx, tenantId)
    const nextLocalPart = body.localPart
    const previousLocalPart = current?.localPart ?? null
    const changingLocalPart = nextLocalPart !== undefined && nextLocalPart !== previousLocalPart
    if (changingLocalPart) await claimLocalPart(tx, nextLocalPart, tenantId, now)

    const opensWindow = changingLocalPart || body.expectForwardingConfirmation === true
    const values = {
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.localPart !== undefined && { localPart: body.localPart }),
      ...(body.allowedSenders !== undefined && {
        allowedSenders: [...new Set(body.allowedSenders)],
      }),
      ...(body.requireAuthentication !== undefined && {
        requireAuthentication: body.requireAuthentication,
      }),
      ...(body.ingestToKnowledge !== undefined && { ingestToKnowledge: body.ingestToKnowledge }),
      ...(opensWindow && {
        confirmationWindowUntil: new Date(
          now.getTime() + INBOX_CONFIRMATION_WINDOW_HOURS * 3_600_000
        ),
      }),
      updatedByUserId: userId,
    }
    const [row] = await tx
      .insert(inboxSettings)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: inboxSettings.tenantId, set: values })
      .returning()
    if (!row) throw new Error('inbox_settings: upsert returned no row')
    if (changingLocalPart && previousLocalPart) {
      await releaseLocalPart(tx, previousLocalPart, tenantId, now)
    }
    return row
  })
}
