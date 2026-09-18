/**
 * Writing a dashboard's visibility (D29, D31) — the half of the kit's access module a plugin has
 * to own for itself.
 *
 * `@/plugins/api` gives a plugin everything it needs to DECLARE a restrictable resource
 * (`VisibilityResource`, `sharedWithMyGroups`, `AccessScope`) and the kit reads that declaration
 * for the predicate and for the 409 `group_in_use` count. What it does not publish are the three
 * helpers the kit's own routes use to READ and WRITE grants — `grantsForResources`,
 * `setResourceGroups` and `resolveRequestedVisibility`. They are reimplemented here, over this
 * plugin's own registry entry, and the two rules they carry are restated rather than inherited:
 *
 * - **A group id is checked against the tenant before it is ever stored**, so a grant can never
 *   name another organisation's group.
 * - **A member may share only with groups they are in** (403 `group_not_yours`); an admin-level
 *   caller with any. Otherwise "restrict to Finance" is a way to hide a dashboard from yourself,
 *   and to discover which groups exist.
 *
 * `visibility: 'tenant'` clears the grants — leaving stale rows behind would silently re-restrict
 * the dashboard the next time somebody flipped it back.
 */
import type { GroupRef, SetVisibilityRequest } from '@rocketflare/shared/groups'
import { and, eq, inArray } from 'drizzle-orm'
import { groups } from '@/db/schema/kit'
import type { Database, RequestCtx } from '@/plugins/api'
import { transaction } from '@/plugins/api'
import { ANALYTICS_PAGE_VISIBILITY, analyticsPageVisibility } from '../visibility'

export interface RequestedVisibility {
  visibility: SetVisibilityRequest['visibility']
  groupIds: string[]
}

/** Every one of these group ids that really belongs to this tenant, in the order given. */
async function groupsInTenant(
  db: Database,
  tenantId: string,
  groupIds: readonly string[]
): Promise<string[]> {
  if (groupIds.length === 0) return []
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), inArray(groups.id, [...groupIds])))
  const found = new Set(rows.map(r => r.id))
  return [...groupIds].filter(id => found.has(id))
}

/**
 * What a CLIENT may ask for. Absent input keeps the default, which is tenant-wide; an id that is
 * not a group of this tenant is refused rather than silently dropped, because a grant that
 * disappears looks exactly like one that was never asked for.
 */
export async function resolveRequestedVisibility(
  ctx: RequestCtx,
  input: SetVisibilityRequest | undefined
): Promise<RequestedVisibility> {
  const visibility = input?.visibility ?? 'tenant'
  if (visibility === 'tenant') return { visibility, groupIds: [] }

  const requested = input?.groupIds ?? []
  const groupIds = await groupsInTenant(ctx.db, ctx.tenantId, requested)
  const unknown = requested.filter(id => !groupIds.includes(id))
  if (unknown.length > 0) {
    ctx.badRequest('No such group in this organisation', 'unknown_group', { groupIds: unknown })
  }
  if (!ctx.scope.bypass) {
    const mine = new Set(ctx.scope.groupIds)
    const outside = groupIds.filter(id => !mine.has(id))
    if (outside.length > 0) {
      ctx.forbidden('You can only share with groups you belong to', 'group_not_yours')
    }
  }
  return { visibility, groupIds }
}

/** Replace a dashboard's visibility and its grants in ONE transaction. */
export async function setPageVisibility(
  ctx: RequestCtx,
  pageId: string,
  requested: RequestedVisibility
): Promise<void> {
  await transaction(ctx.db, async tx => {
    await analyticsPageVisibility.setGroups(
      tx,
      ctx.tenantId,
      pageId,
      { visibility: requested.visibility, groupIds: requested.groupIds },
      requested.groupIds
    )
  })
}

/**
 * The groups each of these dashboards is shared with, in one query — so the badge strip on the
 * list costs one extra round trip rather than one per row.
 */
export async function pageGrants(
  db: Database,
  tenantId: string,
  pageIds: string[]
): Promise<Map<string, GroupRef[]>> {
  const out = new Map<string, GroupRef[]>()
  if (pageIds.length === 0) return out
  const rows = await analyticsPageVisibility.grantRows(db, tenantId, pageIds)
  for (const row of rows) {
    const list = out.get(row.resourceId) ?? []
    list.push({ id: row.id, name: row.name, typeName: row.typeName })
    out.set(row.resourceId, list)
  }
  return out
}

export { ANALYTICS_PAGE_VISIBILITY }
