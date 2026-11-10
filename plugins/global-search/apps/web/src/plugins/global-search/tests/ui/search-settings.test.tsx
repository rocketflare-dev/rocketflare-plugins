/**
 * Settings → Search: an admin picks a preset, saves a key and tests it; the page never shows a
 * stored key, and warns before a URL change clears it.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import {
  jsonResponse,
  makeSession,
  makeTenant,
  renderWithProviders,
  requestBody,
  rulesFor,
  stubFetch,
} from '@testkit/integration'
import { describe, expect, it } from 'vitest'
import SearchSettingsPage from '../../ui/pages/SearchSettings'

const SAVED = {
  rerankEnabled: false,
  rerankBaseUrl: 'https://api.cohere.com/v2',
  rerankModel: 'rerank-v3.5',
  hasCredential: true,
  updatedAt: '2026-11-01T00:00:00.000Z',
}

const owner = () =>
  makeSession({ tenant: makeTenant({ role: 'owner' }), permissions: rulesFor('owner') })

describe('search settings page', () => {
  it('never renders the stored key, and warns that a URL change clears it', async () => {
    const fetch = stubFetch({
      '/api/global-search/settings': jsonResponse(SAVED),
      'PUT /api/global-search/settings': jsonResponse({ ...SAVED, rerankModel: 'rerank-2.5-lite' }),
    })
    renderWithProviders(<SearchSettingsPage />, { session: owner() })
    expect(await screen.findByText(/Key saved/)).toBeInTheDocument()
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')

    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'voyage' } })
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://api.voyageai.com/v1'
    )
    expect(screen.getByText(/Saving clears the stored key/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'voyage-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(requestBody(fetch, 'PUT /api/global-search/settings')).toMatchObject({
        rerankBaseUrl: 'https://api.voyageai.com/v1',
        rerankModel: 'rerank-2.5-lite',
        rerankApiKey: 'voyage-key',
      })
    )
  })

  it('shows a test verdict inline', async () => {
    stubFetch({
      '/api/global-search/settings': jsonResponse(SAVED),
      'POST /api/global-search/settings/test': jsonResponse({
        ok: false,
        error: 'The re-ranker answered 401',
        code: 'auth',
      }),
    })
    renderWithProviders(<SearchSettingsPage />, { session: owner() })
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Test failed · The re-ranker answered 401'
    )
  })
})
