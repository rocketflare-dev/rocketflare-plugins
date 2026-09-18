/**
 * The two subjects this plugin adds to the kit's ability matrix (D10, D31).
 *
 * They were rows in `tests/config/permissions.test.ts` until analytics left the kit; the kit's
 * matrix lost them and this file gained them, which is the rule in one line — a plugin tests its
 * own behaviour, and the host tests that it is a well-formed plugin.
 *
 * `Dashboard` is an `analytics_pages` row: admin-level roles manage it, a member reads it, and "is
 * this page yours" is never a CASL condition — the route ANDs `visibleAnalyticsPages(scope)` onto
 * the tenant predicate (D29). `Analytics` is the cube API itself, which is read-only by nature and
 * open to every member because every cube scopes its own `sql()` by tenant.
 */

import type { Role } from '@rocketflare/shared/permissions'
import { ANALYTICS_SUBJECT, DASHBOARD_SUBJECT } from '@rocketflare/shared/plugins/analytics/index'
import { describe, expect, it } from 'vitest'
import { buildAbility } from '@/permissions/abilities'

const CRUD = ['create', 'read', 'update', 'delete'] as const
const ROLES: Role[] = ['owner', 'admin', 'support', 'member']

const build = (role: Role | null, isGlobalAdmin = false) =>
  buildAbility({ role, isGlobalAdmin, features: [] })

describe('the analytics plugin’s CASL grants', () => {
  for (const role of ROLES) {
    const ability = build(role)
    const manages = role !== 'member'

    it(`${role}: ${manages ? 'manage' : 'read'} ${DASHBOARD_SUBJECT}`, () => {
      expect(ability.can('read', DASHBOARD_SUBJECT)).toBe(true)
      expect(ability.can('manage', DASHBOARD_SUBJECT)).toBe(manages)
      for (const action of CRUD)
        expect(ability.can(action, DASHBOARD_SUBJECT)).toBe(manages || action === 'read')
    })

    it(`${role}: read ${ANALYTICS_SUBJECT}, and never more`, () => {
      expect(ability.can('read', ANALYTICS_SUBJECT)).toBe(true)
      // The cube API is read-only by nature; nobody gets write on it, not even an owner.
      expect(ability.can('manage', ANALYTICS_SUBJECT)).toBe(false)
      expect(ability.can('update', ANALYTICS_SUBJECT)).toBe(false)
    })
  }

  it('a global admin reaches both through `manage all`', () => {
    const ability = build(null, true)
    expect(ability.can('manage', DASHBOARD_SUBJECT)).toBe(true)
    expect(ability.can('manage', ANALYTICS_SUBJECT)).toBe(true)
  })

  it('a session with no role can do neither', () => {
    const ability = build(null)
    expect(ability.can('read', DASHBOARD_SUBJECT)).toBe(false)
    expect(ability.can('read', ANALYTICS_SUBJECT)).toBe(false)
  })
})
