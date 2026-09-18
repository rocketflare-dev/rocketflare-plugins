/**
 * Settings → Web search, through the kit's real providers: an admin can save a key and test it, the
 * page never shows a stored key, and a member sees the settings read-only.
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
import { describe, expect, it } from 'vitest'
import WebSearchSettingsPage from '../../ui/pages/WebSearchSettings'

const SAVED = {
  enabled: false,
  provider: 'tavily',
  hasCredential: true,
  maxResults: 5,
  updatedAt: '2026-09-01T00:00:00.000Z',
}

function sessionAs(role: 'owner' | 'member') {
  const user = makeUser()
  return makeSession({ user, tenant: makeTenant({ role }), permissions: rulesFor(role) })
}

describe('web search settings page', () => {
  it('saves a new key without ever rendering the stored one', async () => {
    const fetch = stubFetch({
      '/api/web-knowledge/settings': jsonResponse(SAVED),
      'PUT /api/web-knowledge/settings': jsonResponse({ ...SAVED, provider: 'brave' }),
    })
    renderWithProviders(<WebSearchSettingsPage />, { session: sessionAs('owner') })

    expect(await screen.findByText(/Key saved/)).toBeInTheDocument()
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')

    fireEvent.change(screen.getByLabelText('Search provider'), { target: { value: 'brave' } })
    expect(screen.getByText(/Saving clears the Tavily key/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'brave-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(requestBody(fetch, 'PUT /api/web-knowledge/settings')).toMatchObject({
        provider: 'brave',
        apiKey: 'brave-key',
      })
    })
  })

  it('shows a test verdict inline', async () => {
    stubFetch({
      '/api/web-knowledge/settings': jsonResponse(SAVED),
      'POST /api/web-knowledge/settings/test': jsonResponse({
        ok: false,
        provider: 'tavily',
        error: 'Tavily rejected the API key',
        code: 'key_rejected',
      }),
    })
    renderWithProviders(<WebSearchSettingsPage />, { session: sessionAs('owner') })
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    expect(await screen.findByText(/Tavily rejected the API key/)).toBeInTheDocument()
  })

  it('is read-only for a member', async () => {
    stubFetch({ '/api/web-knowledge/settings': jsonResponse(SAVED) })
    renderWithProviders(<WebSearchSettingsPage />, { session: sessionAs('member') })
    expect(await screen.findByLabelText('Search provider')).toBeDisabled()
    expect(screen.getByLabelText('API key')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
