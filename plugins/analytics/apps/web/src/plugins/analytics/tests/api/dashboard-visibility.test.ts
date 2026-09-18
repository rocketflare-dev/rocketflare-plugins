/**
 * Dashboard visibility (D29, D31) — the plugin's half of a matrix the kit owns the other half of.
 *
 * Groups are only worth having if EVERY read path agrees about them, so this walks one restricted
 * dashboard past both ways it can reach a person (`GET /pages`, `GET /pages/:id`) for five kinds
 * of reader: its creator, somebody in the group, somebody who is not, an admin and support. It
 * lived in the kit's `tests/api/access-visibility.test.ts` beside documents until analytics became
 * a plugin; a plugin tests its own behaviour, and this is that.
 *
 * The two shapes that matter most are at the bottom. An EMPTY grant list — what deleting the last
 * group a page was shared with leaves — must narrow to the creator and admins rather than publish
 * to the organisation, because `visibility` is a COLUMN and the grants are only grants. And a page
 * the reader may not see must answer the SAME 404 as one that does not exist, so the API is not an
 * existence oracle.
 */
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { groupMembers, groups, groupTypes } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../../../../tests/helpers/auth'
import { setupTestDatabase } from '../../../../../tests/helpers/db'
import { json, request } from '../../../../../tests/helpers/request'
import { analyticsPageGroups } from '../../db/schema/analytics-page-groups'
import { analyticsPages } from '../../db/schema/analytics-pages'

const db = setupTestDatabase()

interface Reader {
  userId: string
  cookie: Record<string, string>
}

let tenantId = ''
let groupId = ''
let restrictedPageId = ''
let openPageId = ''
let creator: Reader
let inGroup: Reader
let outsider: Reader
let admin: Reader
let support: Reader

const EMPTY_CONFIG = { layoutMode: 'rows', rows: [], portlets: [] } as never

async function member(role: 'owner' | 'admin' | 'member' | 'support'): Promise<Reader> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { userId: user.id, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

async function page(
  createdByUserId: string,
  visibility: 'tenant' | 'groups',
  grantTo: string[]
): Promise<string> {
  const [row] = await db
    .insert(analyticsPages)
    .values({
      tenantId,
      slug: `page-${crypto.randomUUID()}`,
      name: 'Finance dashboard',
      config: EMPTY_CONFIG,
      createdByUserId,
      visibility,
    })
    .returning()
  const id = row?.id ?? ''
  for (const gid of grantTo) {
    await db.insert(analyticsPageGroups).values({ tenantId, pageId: id, groupId: gid })
  }
  return id
}

beforeAll(async () => {
  const tenant = await createTestTenant(db)
  tenantId = tenant.id

  creator = await member('owner')
  admin = await member('admin')
  support = await member('support')
  inGroup = await member('member')
  outsider = await member('member')

  const [type] = await db
    .insert(groupTypes)
    .values({ tenantId, name: `Department ${Date.now()}` })
    .returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: `Finance ${Date.now()}` })
    .returning()
  groupId = group?.id ?? ''
  await db.insert(groupMembers).values({ tenantId, groupId, userId: inGroup.userId })

  restrictedPageId = await page(creator.userId, 'groups', [groupId])
  openPageId = await page(creator.userId, 'tenant', [])
})

const readers = (): Array<[string, () => Reader, boolean]> => [
  // `bypass` is `isAdminLevel`, so support is NOT narrowed — deliberately: it is admin-level
  // everywhere else in the kit and it is a membership row the customer can see.
  ['the creator', () => creator, true],
  ['somebody in the group', () => inGroup, true],
  ['somebody who is not', () => outsider, false],
  ['an admin', () => admin, true],
  ['support', () => support, true],
]

describe('a dashboard restricted to a group', () => {
  for (const [label, get, canSee] of readers()) {
    it(`${label} ${canSee ? 'sees' : 'does not see'} it, in the list and by id`, async () => {
      const headers = get().cookie
      const list = await json<{ items: { id: string }[] }>(
        await request('/api/analytics/pages', { headers })
      )
      expect(list.items.map(p => p.id).includes(restrictedPageId)).toBe(canSee)
      expect((await request(`/api/analytics/pages/${restrictedPageId}`, { headers })).status).toBe(
        canSee ? 200 : 404
      )
      // A tenant-wide page is visible to every one of them, so the difference above is the
      // predicate and not the fixture.
      const open = await request(`/api/analytics/pages/${openPageId}`, { headers })
      expect(open.status).toBe(200)
    })
  }

  it('is the SAME 404 as a page that does not exist — never an existence oracle', async () => {
    const missing = await request(`/api/analytics/pages/${crypto.randomUUID()}`, {
      headers: outsider.cookie,
    })
    const hidden = await request(`/api/analytics/pages/${restrictedPageId}`, {
      headers: outsider.cookie,
    })
    expect(hidden.status).toBe(missing.status)
    expect(await json(hidden)).toEqual(await json(missing))
  })
})

describe('an EMPTY grant list is private, not public', () => {
  it('narrows to the creator and admins when the last group goes', async () => {
    const orphaned = await page(creator.userId, 'groups', [groupId])
    await db.delete(analyticsPageGroups).where(eq(analyticsPageGroups.pageId, orphaned))

    for (const [label, get, isAdminLevel] of [
      ['the creator', () => creator, true],
      ['an admin', () => admin, true],
      ['somebody in the group', () => inGroup, false],
      ['somebody who is not', () => outsider, false],
    ] as Array<[string, () => Reader, boolean]>) {
      const res = await request(`/api/analytics/pages/${orphaned}`, { headers: get().cookie })
      expect(res.status, label).toBe(isAdminLevel ? 200 : 404)
    }
  })
})

describe('changing who may see one', () => {
  it('is admin+, never a member who can merely see it', async () => {
    const body = { json: { visibility: 'tenant', groupIds: [] } }
    expect(
      (
        await request(
          `/api/analytics/pages/${restrictedPageId}/visibility`,
          { method: 'PUT', headers: inGroup.cookie },
          body
        )
      ).status
    ).toBe(403)
    expect(
      (
        await request(
          `/api/analytics/pages/${restrictedPageId}/visibility`,
          { method: 'PUT', headers: admin.cookie },
          body
        )
      ).status
    ).toBe(200)
  })
})
