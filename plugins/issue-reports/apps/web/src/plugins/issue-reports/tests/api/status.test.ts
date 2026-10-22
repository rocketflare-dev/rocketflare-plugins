/**
 * `GET /api/issue-reports/status`: whether a conversation can end in an issue — the repository is
 * named only when a token exists too, and the token itself never leaves the server.
 */
import {
  createTestEnv,
  createTestSession,
  createTestTenantWithUser,
  json,
  request,
  sessionCookieHeader,
  setupTestDatabase,
  type TestEnv,
} from '@testkit/integration'
import { describe, expect, it } from 'vitest'

const db = setupTestDatabase()

async function member() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  return sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
}

const status = (headers: Record<string, string>, env: TestEnv) =>
  request('/api/issue-reports/status', { headers }, { env })

describe('GET /api/issue-reports/status', () => {
  it('configured with both; the token is never in the answer', async () => {
    const env = createTestEnv({
      ISSUE_REPORTS_GITHUB_REPO: 'acme/app',
      ISSUE_REPORTS_GITHUB_TOKEN: 'ghp_secret_value',
    } as Partial<TestEnv>)
    const res = await status(await member(), env)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ configured: true, repo: 'acme/app' })
    expect(text).not.toContain('ghp_secret_value')
  })

  it('a repository without a token is not configured, and names nothing', async () => {
    const env = createTestEnv({ ISSUE_REPORTS_GITHUB_REPO: 'acme/app' } as Partial<TestEnv>)
    expect(await json(await status(await member(), env))).toEqual({ configured: false, repo: null })
  })

  it('401 without a session', async () => {
    expect((await status({}, createTestEnv())).status).toBe(401)
  })
})
