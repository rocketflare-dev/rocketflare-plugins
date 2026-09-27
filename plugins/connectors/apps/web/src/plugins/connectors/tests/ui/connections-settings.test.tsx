/**
 * Settings → Connections and My calendar, through the kit's real providers: an admin connects
 * (and is sent to the consent URL), sees sync progress once connected, and a member sees the page
 * read-only; the calendar lists the reader's events.
 *
 * Each audience sees only what it can act on: a tenant admin gets consent (or "ask your platform
 * operator", plus bring-your-own) and never the deployment's setup; a platform operator gets the
 * deployment's setup and the pointer to the `connectors` skill; a member gets nothing to press.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import {
  jsonResponse,
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
  requestBody,
  rulesFor,
  stubFetch,
} from '@testkit/integration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectionsSettingsPage from '../../ui/pages/ConnectionsSettings'
import MyCalendarPage from '../../ui/pages/MyCalendarPage'

const PROVIDER = {
  id: 'm365',
  label: 'Microsoft 365',
  description: 'Directory and calendars.',
  operatorConfigured: true,
  supportsByo: true,
  resources: ['users', 'groups', 'calendar'],
  adminSteps: ['Press connect.'],
  // What the server sends a tenant admin: the operator's steps are left out.
  operatorSteps: [] as string[],
  permissions: [{ scope: 'User.Read.All', reason: 'people' }],
  docsUrl: null,
  redirectUri: 'https://app.example.test/api/hooks/connectors/m365/callback',
}

/** The providers list as the server answers one audience. */
function providersFor(isOperator: boolean, overrides: Partial<typeof PROVIDER> = {}): Response {
  return jsonResponse({
    items: [
      {
        ...PROVIDER,
        operatorSteps: isOperator ? ['Register the deployment app in Entra.'] : [],
        ...overrides,
      },
    ],
    viewer: { isOperator },
  })
}

const INSTALLATION = {
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'm365',
  status: 'active',
  appMode: 'operator',
  hasCredential: false,
  externalTenantId: '0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607',
  displayName: 'Contoso',
  grantedScopes: ['User.Read.All'],
  installedAt: '2026-09-01T00:00:00.000Z',
  lastError: null,
  counts: { users: 12, matchedUsers: 3, groups: 4, mailboxes: 3, events: 40 },
  cursors: [
    {
      resource: 'users',
      count: 1,
      backfilling: 0,
      lastSyncedAt: '2026-09-01T00:00:00.000Z',
      failing: 0,
      lastError: null,
    },
  ],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

function sessionAs(role: 'owner' | 'member', isGlobalAdmin = false) {
  return makeSession({
    user: makeUser({ isGlobalAdmin }),
    tenant: makeTenant({ role }),
    permissions: rulesFor(role, isGlobalAdmin),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('connections settings', () => {
  it('starts consent and sends the browser to the provider', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, href: window.location.href })
    const fetch = stubFetch({
      '/api/connectors/providers': providersFor(false),
      '/api/connectors/installations': jsonResponse({ items: [] }),
      'POST /api/connectors/installations': jsonResponse(
        { installationId: INSTALLATION.id, consentUrl: 'https://login.microsoftonline.com/x' },
        201
      ),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('owner') })
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Microsoft 365' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/x'))
    expect(requestBody(fetch, 'POST /api/connectors/installations')).toEqual({
      provider: 'm365',
      appMode: 'operator',
    })
  })

  it('shows a connected installation and its sync state, read-only for a member', async () => {
    stubFetch({
      '/api/connectors/providers': providersFor(false),
      '/api/connectors/installations': jsonResponse({ items: [INSTALLATION] }),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('member') })
    expect(await screen.findByText('Contoso')).toBeInTheDocument()
    expect(screen.getByText(/12 people \(3 members of this app\)/)).toBeInTheDocument()
    expect(screen.getByText('up to date')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument()
  })

  it('shows a tenant admin the consent and permissions, never the deployment’s setup', async () => {
    stubFetch({
      '/api/connectors/providers': providersFor(false),
      '/api/connectors/installations': jsonResponse({ items: [] }),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('owner') })
    expect(await screen.findByText('Press connect.')).toBeInTheDocument()
    expect(screen.getByText(/Permissions requested \(1\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Microsoft 365' })).toBeEnabled()
    expect(screen.queryByText(/Deployment setup/)).not.toBeInTheDocument()
    expect(screen.queryByText(/isn't set up on this deployment/)).not.toBeInTheDocument()
  })

  it('tells a tenant admin to ask the operator when the app is missing, and offers their own', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, href: window.location.href })
    const fetch = stubFetch({
      '/api/connectors/providers': providersFor(false, { operatorConfigured: false }),
      '/api/connectors/installations': jsonResponse({ items: [] }),
      'POST /api/connectors/installations': jsonResponse(
        { installationId: INSTALLATION.id, consentUrl: 'https://login.microsoftonline.com/byo' },
        201
      ),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('owner') })
    expect(await screen.findByText(/ask your platform operator/)).toBeInTheDocument()
    // No operator steps, no skill pointer: neither is theirs to act on.
    expect(screen.queryByText(/Deployment setup/)).not.toBeInTheDocument()
    expect(screen.queryByText(/coding agent/)).not.toBeInTheDocument()
    // Their own app is the way in: the registration steps carry this deployment's redirect URI.
    expect(screen.getByText("Connect your organisation's own app")).toBeInTheDocument()
    expect(screen.getByText(PROVIDER.redirectUri)).toBeInTheDocument()
    const connect = screen.getByRole('button', { name: 'Connect Microsoft 365' })
    expect(connect).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Client id'), { target: { value: 'their-client' } })
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'their-secret' } })
    fireEvent.click(connect)
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/byo')
    )
    expect(requestBody(fetch, 'POST /api/connectors/installations')).toEqual({
      provider: 'm365',
      appMode: 'byo',
      clientId: 'their-client',
      clientSecret: 'their-secret',
    })
  })

  it('shows a platform operator the deployment’s setup and the connectors skill', async () => {
    stubFetch({
      '/api/connectors/providers': providersFor(true, { operatorConfigured: false }),
      '/api/connectors/installations': jsonResponse({ items: [] }),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('owner', true) })
    expect(
      await screen.findByText(/Deployment setup \(platform operator\) — not configured/)
    ).toBeInTheDocument()
    expect(screen.getByText('Register the deployment app in Entra.')).toBeVisible()
    expect(screen.getAllByText(/coding agent/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/ask your platform operator/)).not.toBeInTheDocument()
  })

  it('gives a member nothing to press before a connection exists', async () => {
    stubFetch({
      '/api/connectors/providers': providersFor(false, { operatorConfigured: false }),
      '/api/connectors/installations': jsonResponse({ items: [] }),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('member') })
    expect(await screen.findByText(/Not connected yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/ask your platform operator/)).not.toBeInTheDocument()
    expect(screen.queryByText('Press connect.')).not.toBeInTheDocument()
  })

  it('re-grants a bring-your-own app by asking for its credentials again', async () => {
    stubFetch({
      '/api/connectors/providers': providersFor(false),
      '/api/connectors/installations': jsonResponse({
        items: [{ ...INSTALLATION, appMode: 'byo', hasCredential: true }],
      }),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('owner') })
    fireEvent.click(await screen.findByRole('button', { name: 'Re-grant consent' }))
    expect(screen.getByLabelText('Client secret')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry consent' })).toBeDisabled()
  })

  it('says so when no provider plugin is installed', async () => {
    stubFetch({
      '/api/connectors/providers': jsonResponse({ items: [], viewer: { isOperator: false } }),
      '/api/connectors/installations': jsonResponse({ items: [] }),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('owner') })
    expect(await screen.findByText(/No provider is installed/)).toBeInTheDocument()
  })
})

describe('my calendar', () => {
  it('lists the reader’s events for the week', async () => {
    const start = new Date(Date.now() + 3_600_000).toISOString()
    stubFetch({
      '/api/connectors/events': jsonResponse({
        items: [
          {
            id: '00000000-0000-4000-8000-0000000000e1',
            provider: 'm365',
            ownerUserId: null,
            title: 'Planning',
            startsAt: start,
            endsAt: start,
            isAllDay: false,
            location: 'Room 1',
            organizerEmail: 'ada@contoso.com',
            organizerName: 'Ada',
            attendees: [],
            webLink: null,
            isCancelled: false,
          },
        ],
        truncated: false,
      }),
    })
    renderWithProviders(<MyCalendarPage />, { session: sessionAs('member') })
    expect(await screen.findByText('Planning')).toBeInTheDocument()
    expect(screen.getByText(/organised by Ada/)).toBeInTheDocument()
  })
})
