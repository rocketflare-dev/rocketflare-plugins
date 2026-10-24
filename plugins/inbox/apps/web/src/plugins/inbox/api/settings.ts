/**
 * `inbox_settings`: read, shape and upsert one organisation's row. The local part is unique across
 * tenants (it is how a message finds its organisation), so a taken one is a 409 at the route rather
 * than a raw unique violation.
 */
import type { InboxSettings, UpdateInboxSettings } from '@rocketflare/shared/plugins/inbox/index'
import { eq } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import { type InboxSettingsRow, inboxSettings } from '../db/schema'

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
    updatedAt: row?.updatedAt ?? null,
  }
}

export async function saveSettings(
  db: Database,
  tenantId: string,
  userId: string | null,
  body: UpdateInboxSettings
): Promise<InboxSettingsRow> {
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
    updatedByUserId: userId,
  }
  const [row] = await db
    .insert(inboxSettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: inboxSettings.tenantId, set: values })
    .returning()
  if (!row) throw new Error('inbox_settings: upsert returned no row')
  return row
}
