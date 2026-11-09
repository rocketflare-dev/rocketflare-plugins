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
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ENTRA_CLIENT_ID, fakeEntra } from '../entra-fixture'

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

  async function start(env: ReturnType<typeof createTestEnv>) {
    const res = await request(
      '/api/connectors/installations',
      { method: 'POST', headers: ownerCookie },
      { json: { provider: 'm365' }, env }
    )
    expect(res.status).toBe(201)
    return new URL((await json<{ consentUrl: string }>(res)).consentUrl)
  }

  const installationOf = async (env: ReturnType<typeof createTestEnv>) => {
    const list = await json<{
      items: { provider: string; status: string; externalTenantId: string | null }[]
    }>(await request('/api/connectors/installations', { headers: ownerCookie }, { env }))
    return list.items.find(i => i.provider === 'm365')
  }

  afterEach(() => vi.unstubAllGlobals())

  it('activates only after a verified sign-in names the consented organisation', async () => {
    const env = createTestEnv({ M365_CLIENT_ID: ENTRA_CLIENT_ID, M365_CLIENT_SECRET: 'shh' })
    const url = await start(env)
    expect(url.host).toBe('login.microsoftonline.com')
    expect(url.searchParams.get('client_id')).toBe(ENTRA_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${env.APP_URL}/api/hooks/connectors/m365/callback`
    )

    const claimed = await request(
      `/api/hooks/connectors/m365/callback?admin_consent=True&tenant=${TENANT}&state=${url.searchParams.get('state')}`,
      {},
      { env }
    )
    expect(claimed.status).toBe(302)
    const signIn = new URL(claimed.headers.get('location') ?? '')
    expect(signIn.host).toBe('login.microsoftonline.com')
    expect(signIn.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`)
    expect(await installationOf(env)).toMatchObject({ status: 'pending', externalTenantId: null })

    const entra = await fakeEntra(TENANT, { nonce: signIn.searchParams.get('nonce') })
    vi.stubGlobal('fetch', entra.fetch)
    const done = await request(
      `/api/hooks/connectors/m365/callback?code=the-code&state=${signIn.searchParams.get('state')}`,
      {},
      { env }
    )
    expect(done.headers.get('location')).toContain('connected=m365')
    expect(entra.tokenRequests).toEqual([`/${TENANT}/oauth2/v2.0/token`])
    expect(await installationOf(env)).toMatchObject({
      status: 'active',
      externalTenantId: TENANT,
    })
  })

  it('stays pending when the sign-in proves a different organisation', async () => {
    const claimedTenant = crypto.randomUUID()
    const tenant = (await createTestTenant(db)).id
    const owner = await createTestUser(db)
    await linkUserToTenant(db, owner.id, tenant, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant))
    const env = createTestEnv({ M365_CLIENT_ID: ENTRA_CLIENT_ID, M365_CLIENT_SECRET: 'shh' })
    const started = await request(
      '/api/connectors/installations',
      { method: 'POST', headers: cookie },
      { json: { provider: 'm365' }, env }
    )
    const url = new URL((await json<{ consentUrl: string }>(started)).consentUrl)
    const claimed = await request(
      `/api/hooks/connectors/m365/callback?admin_consent=True&tenant=${claimedTenant}&state=${url.searchParams.get('state')}`,
      {},
      { env }
    )
    const signIn = new URL(claimed.headers.get('location') ?? '')
    const entra = await fakeEntra(claimedTenant, {
      tid: '99999999-2222-4333-8444-555555555555',
      nonce: signIn.searchParams.get('nonce'),
    })
    vi.stubGlobal('fetch', entra.fetch)
    const refused = await request(
      `/api/hooks/connectors/m365/callback?code=c&state=${signIn.searchParams.get('state')}`,
      {},
      { env }
    )
    expect(refused.headers.get('location')).toContain('connectError=')
    const list = await json<{
      items: { provider: string; status: string; externalTenantId: string | null }[]
    }>(await request('/api/connectors/installations', { headers: cookie }, { env }))
    expect(list.items.find(i => i.provider === 'm365')).toMatchObject({
      status: 'pending',
      externalTenantId: null,
    })
  })
})
