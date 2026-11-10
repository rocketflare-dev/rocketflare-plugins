/**
 * `global-search:people` — the organisation's members, by name or email. Guarded by
 * `manage TenantMember`, the permission behind Settings → People, which is where the kit shows a
 * member: a reader who cannot open that page is never offered a person.
 *
 * Tenant-scoped by the membership row (`tenant_users.tenant_id` = the reader's tenant), never by
 * the user row, which is global. The href carries the member id (`&member=`) so two people are two
 * results — the fusion keys on href — though the People tab opens on its list either way.
 */
import { and, asc, eq, or } from 'drizzle-orm'
import { tenantUsers, users } from '@/db/schema/kit'
import type { SearchProvider } from '../types'
import { containsText, matchRank } from './match'

export const PEOPLE_PROVIDER_ID = 'global-search:people'
export const PERSON_KIND = 'person'

export const memberHref = (userId: string) =>
  `/settings?tab=people&member=${encodeURIComponent(userId)}`

export const peopleProvider: SearchProvider = {
  id: PEOPLE_PROVIDER_ID,
  label: 'People',
  kinds: [{ kind: PERSON_KIND, label: 'People', badge: 'person', tone: 'success', order: 10 }],
  guard: { action: 'manage', subject: 'TenantMember' },
  async search(ctx, { q, pool }) {
    const rank = matchRank(users.name, q)
    const emailRank = matchRank(users.email, q)
    const rows = await ctx.db
      .select({ id: users.id, name: users.name, email: users.email, role: tenantUsers.role })
      .from(tenantUsers)
      .innerJoin(users, eq(users.id, tenantUsers.userId))
      .where(
        and(
          eq(tenantUsers.tenantId, ctx.tenantId),
          or(containsText(users.name, q), containsText(users.email, q))
        )
      )
      .orderBy(asc(rank), asc(emailRank), asc(users.name), asc(users.email))
      .limit(pool)
    return rows.map(r => ({
      kind: PERSON_KIND,
      title: r.name || r.email,
      snippet: `${r.email} · ${r.role}`,
      ref: r.id,
      href: memberHref(r.id),
    }))
  },
}
