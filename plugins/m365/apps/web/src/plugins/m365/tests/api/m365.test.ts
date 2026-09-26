/**
 * The Microsoft 365 provider inside the host, on real Postgres: it is contributed to the
 * `connectors` registry by being installed, the Connections surface offers it, and an admin's
 * "Connect" hands out a real Entra admin-consent URL whose `state` completes the round trip on the
 * public callback. Tenant data isolation is `connectors`' to prove — this plugin owns no table.
 */
import {
  createTestEnv,
  createTestSession,
  createTestTenant,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
} from '@testkit/integration'
import { beforeAll, describe, expect, it } from 'vitest'

const db = setupTestDatabase()
const TENANT = '0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607'

let ownerCookie: Record<string, string>

beforeAll(async () => {
  const tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))
})

describe('m365 in the connectors registry', () => {
  it('is offered, and says when the deployment has no Entra app', async () => {
    const bare = await request('/api/connectors/providers', { headers: ownerCookie })
    const { items } = await json<{ items: { id: string; operatorConfigured: boolean }[] }>(bare)
    expect(items.find(p => p.id === 'm365')).toMatchObject({ operatorConfigured: false })

    const refused = await request(
      '/api/connectors/installations',
      { method: 'POST', headers: ownerCookie },
      { json: { provider: 'm365' } }
    )
    expect(refused.status).toBe(503)
    expect(await json(refused)).toMatchObject({ code: 'connector_not_configured' })
  })

  it('hands out an admin-consent URL whose state completes on the public callback', async () => {
    const env = createTestEnv({ M365_CLIENT_ID: 'operator-app', M365_CLIENT_SECRET: 'shh' })
    const res = await request(
      '/api/connectors/installations',
      { method: 'POST', headers: ownerCookie },
      { json: { provider: 'm365' }, env }
    )
    expect(res.status).toBe(201)
    const { consentUrl } = await json<{ consentUrl: string }>(res)
    const url = new URL(consentUrl)
    expect(url.host).toBe('login.microsoftonline.com')
    expect(url.searchParams.get('client_id')).toBe('operator-app')
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${env.APP_URL}/api/hooks/connectors/m365/callback`
    )

    const back = await request(
      `/api/hooks/connectors/m365/callback?admin_consent=True&tenant=${TENANT}&state=${url.searchParams.get('state')}`,
      {},
      { env }
    )
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toContain('connected=m365')
    const list = await json<{
      items: { provider: string; status: string; externalTenantId: string }[]
    }>(await request('/api/connectors/installations', { headers: ownerCookie }, { env }))
    expect(list.items).toContainEqual(
      expect.objectContaining({ provider: 'm365', status: 'active', externalTenantId: TENANT })
    )
  })
})
