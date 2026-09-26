/**
 * The Microsoft 365 provider with no database and no network: every Graph and Entra call is a fake
 * `fetch`, so these pin what Microsoft is sent (the consent URL, the token grant, the delta
 * requests and their headers), how its answers are normalised (partial deltas, guests, UTC,
 * removals, membership deltas), and how each of its failures steers the engine.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ConnectorAuthError,
  ConsentError,
  CursorExpiredError,
  RetryLaterError,
  type SourceCtx,
} from '@/plugins/connectors'
import { clientCredentialsToken, graphGet, graphUrl, tokenRoles } from '../../graph'
import {
  m365Provider,
  toCalendarEvent,
  toDirectoryGroup,
  toDirectoryUser,
  userEmail,
} from '../../provider'

type Captured = { url: string; init: RequestInit | undefined }

function fakeFetch(...answers: Response[]) {
  const calls: Captured[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = answers.shift()
    if (!next) throw new Error(`unexpected request to ${String(input)}`)
    return next
  })
  return { fetch, calls }
}

const header = (c: Captured | undefined, name: string) => new Headers(c?.init?.headers).get(name)
const TENANT = '0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607'

function ctx(fetch: SourceCtx['fetch']): SourceCtx {
  return {
    installation: {
      id: 'i',
      tenantId: 't',
      externalTenantId: TENANT,
      appMode: 'operator',
      settings: {},
    },
    token: async () => 'app-token',
    fetch,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as SourceCtx['logger'],
  }
}

/** A JWT whose payload carries `roles` — all `tokenRoles` reads. */
function jwt(payload: object): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

describe('consent', () => {
  it('sends the admin to the organizations admin-consent endpoint with our state', () => {
    const url = new URL(
      m365Provider.consentUrl({
        credentials: { clientId: 'app-id', clientSecret: 's' },
        redirectUri: 'https://app.example/api/hooks/connectors/m365/callback',
        state: 'signed.state',
      })
    )
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/organizations/v2.0/adminconsent'
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'app-id',
      scope: 'https://graph.microsoft.com/.default',
      redirect_uri: 'https://app.example/api/hooks/connectors/m365/callback',
      state: 'signed.state',
    })
  })

  it('reads the tenant from a granted consent', () => {
    const query = new URLSearchParams({ admin_consent: 'True', tenant: TENANT.toUpperCase() })
    expect(m365Provider.completeConsent({ query })).toEqual({ externalTenantId: TENANT })
  })

  it('maps a refusal to a code the settings page can explain', () => {
    const cancel = new URLSearchParams({
      error: 'access_denied',
      error_description: 'AADSTS65004: declined\r\nTrace ID: x',
    })
    expect(() => m365Provider.completeConsent({ query: cancel })).toThrowError(
      expect.objectContaining({ code: 'consent_not_granted', message: 'AADSTS65004: declined' })
    )
    const notAdmin = new URLSearchParams({ error: 'consent_required' })
    expect(() => m365Provider.completeConsent({ query: notAdmin })).toThrowError(
      expect.objectContaining({ code: 'admin_consent_required' })
    )
    for (const q of [
      { admin_consent: 'False', tenant: TENANT },
      { admin_consent: 'True', tenant: 'common' },
    ]) {
      expect(() => m365Provider.completeConsent({ query: new URLSearchParams(q) })).toThrow(
        ConsentError
      )
    }
  })

  it('has operator credentials only when both secrets are set', () => {
    expect(m365Provider.operatorCredentials({ M365_CLIENT_ID: 'a' } as never)).toBeNull()
    expect(
      m365Provider.operatorCredentials({ M365_CLIENT_ID: 'a', M365_CLIENT_SECRET: 'b' } as never)
    ).toEqual({ clientId: 'a', clientSecret: 'b' })
  })
})

describe('tokens', () => {
  it('runs the client-credentials grant against the customer tenant and reads the granted roles', async () => {
    const token = jwt({ roles: ['User.Read.All', 'Calendars.Read'] })
    const { fetch, calls } = fakeFetch(Response.json({ access_token: token, expires_in: 3599 }))
    const minted = await m365Provider.mintToken({
      credentials: { clientId: 'app-id', clientSecret: 'shh' },
      installation: ctx(fetch).installation,
      subject: null,
      fetch,
    })
    expect(calls[0]?.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body)))).toEqual({
      client_id: 'app-id',
      client_secret: 'shh',
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    })
    expect(minted.scopes).toEqual(['Calendars.Read', 'User.Read.All'])
    expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000)
  })

  it('a refused app is an auth error; an outage is a retry', async () => {
    const revoked = fakeFetch(
      Response.json(
        {
          error: 'unauthorized_client',
          error_description:
            "AADSTS700016: Application with identifier 'x' was not found in the directory.\r\nTrace ID: y",
        },
        { status: 400 }
      )
    )
    await expect(
      clientCredentialsToken(revoked.fetch, { tenant: TENANT, clientId: 'x', clientSecret: 'y' })
    ).rejects.toBeInstanceOf(ConnectorAuthError)
    const expired = fakeFetch(
      Response.json(
        { error: 'invalid_client', error_description: 'AADSTS7000222: expired' },
        { status: 401 }
      )
    )
    await expect(
      clientCredentialsToken(expired.fetch, { tenant: TENANT, clientId: 'x', clientSecret: 'y' })
    ).rejects.toThrow(/AADSTS7000222/)
    const down = fakeFetch(new Response('', { status: 503, headers: { 'Retry-After': '7' } }))
    await expect(
      clientCredentialsToken(down.fetch, { tenant: TENANT, clientId: 'x', clientSecret: 'y' })
    ).rejects.toMatchObject({ retryAfterSeconds: 7 })
  })

  it('reads no roles from a token that has none, or is not a JWT', () => {
    expect(tokenRoles(jwt({}))).toEqual([])
    expect(tokenRoles('opaque')).toEqual([])
  })
})

describe('Graph requests', () => {
  it('never sends the token anywhere but graph.microsoft.com', async () => {
    expect(() => graphUrl('https://evil.example/v1.0/users/delta')).toThrow(/Refusing/)
    const { fetch } = fakeFetch()
    await expect(
      graphGet(fetch, 't', 'https://graph.microsoft.com.evil.example/x', 'directory')
    ).rejects.toThrow(/Refusing/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps throttling, expired cursors and refusals onto the engine’s errors', async () => {
    const cases: [Response, 'directory' | 'mailbox', unknown][] = [
      [
        new Response('', { status: 429, headers: { 'Retry-After': '12' } }),
        'directory',
        RetryLaterError,
      ],
      [new Response('', { status: 503 }), 'mailbox', RetryLaterError],
      [new Response('', { status: 410 }), 'directory', CursorExpiredError],
      [
        Response.json({ error: { code: 'syncStateNotFound' } }, { status: 400 }),
        'mailbox',
        CursorExpiredError,
      ],
      [
        Response.json({ error: { code: 'Authorization_RequestDenied' } }, { status: 403 }),
        'directory',
        ConnectorAuthError,
      ],
    ]
    for (const [res, access, kind] of cases) {
      const { fetch } = fakeFetch(res)
      await expect(graphGet(fetch, 't', '/v1.0/users/delta', access)).rejects.toBeInstanceOf(
        kind as never
      )
    }
    // A single mailbox refusing is that mailbox's problem, not the installation's.
    const { fetch } = fakeFetch(
      Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 })
    )
    const err = await graphGet(fetch, 't', '/v1.0/users/x/calendarView/delta', 'mailbox').catch(
      e => e
    )
    expect(err).not.toBeInstanceOf(ConnectorAuthError)
    expect(String(err)).toContain('ErrorAccessDenied')
  })
})

describe('directory', () => {
  it('pages users/delta: a next link, then the delta link, removals separated', async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        value: [
          {
            id: 'u1',
            displayName: 'Ada',
            mail: 'Ada@contoso.com',
            jobTitle: null,
            accountEnabled: true,
          },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/delta?$skiptoken=abc',
      }),
      Response.json({
        value: [{ id: 'u2', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=xyz',
      })
    )
    const first = await m365Provider.directory.users(ctx(fetch), null)
    expect(first).toMatchObject({
      items: [
        { externalId: 'u1', email: 'Ada@contoso.com', displayName: 'Ada', accountEnabled: true },
      ],
      removed: [],
      next: 'https://graph.microsoft.com/v1.0/users/delta?$skiptoken=abc',
      final: null,
    })
    expect(calls[0]?.url).toContain(
      '/v1.0/users/delta?$select=id,displayName,mail,userPrincipalName,jobTitle,accountEnabled'
    )
    expect(header(calls[0], 'authorization')).toBe('Bearer app-token')
    expect(header(calls[0], 'x-ms-throttle-priority')).toBe('low')

    const second = await m365Provider.directory.users(ctx(fetch), first.next)
    expect(second).toEqual({
      items: [],
      removed: ['u2'],
      next: null,
      final: 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=xyz',
    })
    expect(calls[1]?.url).toBe('https://graph.microsoft.com/v1.0/users/delta?$skiptoken=abc')
  })

  it('keeps a partial delta partial, and never uses a guest UPN as an address', () => {
    expect(toDirectoryUser({ id: 'u1', jobTitle: 'CTO' })).toEqual({
      externalId: 'u1',
      jobTitle: 'CTO',
    })
    expect(userEmail({ mail: null, userPrincipalName: 'ada@contoso.com' })).toBe('ada@contoso.com')
    expect(
      userEmail({ mail: null, userPrincipalName: 'ada_gmail.com#EXT#@contoso.onmicrosoft.com' })
    ).toBeNull()
    expect(toDirectoryUser({ id: 'u1', accountEnabled: false })).toEqual({
      externalId: 'u1',
      accountEnabled: false,
    })
  })

  it('turns members@delta into people added and removed, ignoring non-people', () => {
    expect(
      toDirectoryGroup({
        id: 'g1',
        displayName: 'Eng',
        'members@delta': [
          { '@odata.type': '#microsoft.graph.user', id: 'u1' },
          { '@odata.type': '#microsoft.graph.user', id: 'u2', '@removed': { reason: 'deleted' } },
          { '@odata.type': '#microsoft.graph.group', id: 'g-nested' },
        ],
      })
    ).toEqual({
      externalId: 'g1',
      displayName: 'Eng',
      members: { mode: 'delta', added: ['u1'], removed: ['u2'] },
    })
  })
})

describe('calendar', () => {
  it('asks for the window in UTC and normalises events', async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({
        value: [
          {
            id: 'e1',
            subject: 'Standup',
            start: { dateTime: '2026-10-01T09:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-10-01T09:15:00.0000000', timeZone: 'UTC' },
            isAllDay: false,
            location: { displayName: 'Room 1' },
            organizer: { emailAddress: { name: 'Ada', address: 'ada@contoso.com' } },
            attendees: [
              {
                emailAddress: { address: 'bob@contoso.com', name: 'Bob' },
                status: { response: 'accepted' },
              },
            ],
            webLink: 'https://outlook.office365.com/owa/?itemid=e1',
          },
          { id: 'e2', '@removed': { reason: 'deleted' } },
        ],
        '@odata.deltaLink':
          'https://graph.microsoft.com/v1.0/users/u1/calendarView/delta?$deltatoken=d',
      })
    )
    const window = {
      start: new Date('2026-09-01T00:00:00Z'),
      end: new Date('2026-12-30T00:00:00Z'),
    }
    const page = await m365Provider.calendar?.events(
      { ...ctx(fetch), subject: { externalId: 'u1', email: 'ada@contoso.com' }, window },
      null
    )
    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/v1.0/users/u1/calendarView/delta')
    expect(url.searchParams.get('startDateTime')).toBe('2026-09-01T00:00:00.000Z')
    expect(url.searchParams.get('endDateTime')).toBe('2026-12-30T00:00:00.000Z')
    expect(header(calls[0], 'prefer')).toContain('outlook.timezone="UTC"')
    expect(page?.removed).toEqual(['e2'])
    expect(page?.items[0]).toMatchObject({
      externalId: 'e1',
      title: 'Standup',
      startsAt: new Date('2026-10-01T09:00:00Z'),
      endsAt: new Date('2026-10-01T09:15:00Z'),
      location: 'Room 1',
      organizerEmail: 'ada@contoso.com',
      attendees: [{ email: 'bob@contoso.com', name: 'Bob', response: 'accepted' }],
    })
    expect(page?.final).toContain('$deltatoken=d')
  })

  it('drops an event with no usable time rather than inventing one', () => {
    expect(toCalendarEvent({ id: 'x', subject: 'broken' })).toBeNull()
  })
})
