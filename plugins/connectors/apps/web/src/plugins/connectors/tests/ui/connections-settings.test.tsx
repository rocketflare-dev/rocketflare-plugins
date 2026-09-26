/**
 * Settings → Connections and My calendar, through the kit's real providers: an admin connects
 * (and is sent to the consent URL), sees sync progress once connected, and a member sees the page
 * read-only; the calendar lists the reader's events.
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
  operatorSteps: ['Register the app.'],
  permissions: [{ scope: 'User.Read.All', reason: 'people' }],
  docsUrl: null,
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

function sessionAs(role: 'owner' | 'member') {
  return makeSession({
    user: makeUser(),
    tenant: makeTenant({ role }),
    permissions: rulesFor(role),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('connections settings', () => {
  it('starts consent and sends the browser to the provider', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, href: window.location.href })
    const fetch = stubFetch({
      '/api/connectors/providers': jsonResponse({ items: [PROVIDER] }),
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
      '/api/connectors/providers': jsonResponse({ items: [PROVIDER] }),
      '/api/connectors/installations': jsonResponse({ items: [INSTALLATION] }),
    })
    renderWithProviders(<ConnectionsSettingsPage />, { session: sessionAs('member') })
    expect(await screen.findByText('Contoso')).toBeInTheDocument()
    expect(screen.getByText(/12 people \(3 members of this app\)/)).toBeInTheDocument()
    expect(screen.getByText('up to date')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument()
  })

  it('says so when no provider plugin is installed', async () => {
    stubFetch({
      '/api/connectors/providers': jsonResponse({ items: [] }),
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
