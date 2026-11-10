/**
 * `/search/all`: the full results of `GET /api/global-search` — ranked, with kind badges from the
 * registered providers and a cleaned snippet; the kind facets come from the providers, count from
 * the unfiltered search, live in the URL and reach the request; a partial answer and a
 * keyword-only one are stated in `role="status"` notices, never hidden.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { makeSession, renderWithProviders, stubFetch } from '@testkit/integration'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import SearchPage from '../../ui/pages/SearchPage'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.search}</div>
}

const HITS = [
  {
    kind: 'page',
    title: 'Settings',
    snippet: null,
    ref: '/settings',
    href: '/settings',
    provider: 'global-search:nav',
    score: 1 / 61,
    scoring: {
      sources: [{ list: 'global-search:nav', rank: 1, weight: 1, contribution: 1 / 61 }],
      fused: 1 / 61,
      rerank: { score: 0.93, before: 2, after: 1 },
    },
  },
  {
    kind: 'question',
    title: 'Who may change settings?',
    snippet:
      '# Who may change settings? Item: question:GQ-0004 Question: Should a member change the organisation settings?',
    ref: 'GQ-0004',
    href: '/acme/questions/GQ-0004',
    provider: 'acme:questions',
    score: 1 / 62,
    scoring: {
      sources: [
        { list: 'acme:questions', rank: 2, weight: 1, contribution: 1 / 62, lexical: 3, dense: 1 },
      ],
      fused: 1 / 62,
    },
  },
  {
    kind: 'document',
    title: 'Settings handbook',
    snippet: 'The **settings** handbook.',
    ref: 'd1',
    href: '/documents/d1?offset=0&q=settings',
    provider: 'global-search:documents',
    score: 1 / 63,
  },
]

const PROVIDERS = {
  providers: [
    {
      id: 'global-search:nav',
      label: 'Pages',
      kinds: [{ kind: 'page', label: 'Pages', badge: 'page', tone: 'accent', order: 0 }],
    },
    {
      id: 'acme:questions',
      label: 'Questions',
      kinds: [{ kind: 'question', label: 'Open questions', badge: 'question', order: 20 }],
      snippetLabels: { fields: ['Item', 'Question'], noise: ['Item'], bare: ['Question'] },
    },
    {
      id: 'global-search:documents',
      label: 'Knowledge base',
      kinds: [{ kind: 'document', label: 'Documents', badge: 'document', tone: 'info', order: 50 }],
    },
  ],
}

function render(search: string, extra: Record<string, unknown> = {}) {
  const urls: URL[] = []
  stubFetch({
    '/api/global-search': (_init: RequestInit | undefined, url: URL) => {
      urls.push(url)
      const kinds = url.searchParams.get('kinds')?.split(',')
      return {
        items: kinds ? HITS.filter(h => kinds.includes(h.kind)) : HITS,
        semantic: 'used',
        degraded: [],
        ranking: {
          method: 'rrf',
          k: 60,
          lists: 3,
          rerank: { applied: true, model: 'rerank-v3.5', candidates: 3 },
        },
        ...extra,
      }
    },
    '/api/global-search/providers': PROVIDERS,
  })
  renderWithProviders(
    <Routes>
      <Route
        path="/search/all"
        element={
          <>
            <SearchPage />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { route: `/search/all${search}`, session: makeSession() }
  )
  return { urls }
}

describe('/search/all', () => {
  it('ranks the hits with their kind badge and a cleaned snippet', async () => {
    render('?q=settings')
    const results = await screen.findByRole('list', { name: 'Results' })
    const rows = within(results).getAllByRole('listitem')
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings'
    )
    await waitFor(() => expect(rows[0]).toHaveTextContent('page'))
    // A provider's labels: the question's text, not its heading and id fields.
    await waitFor(() =>
      expect(rows[1]).toHaveTextContent('Should a member change the organisation settings?')
    )
    expect(rows[1]).not.toHaveTextContent('GQ-0004')
    expect(rows[2]).toHaveTextContent('The settings handbook.')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('counts each kind from the unfiltered search, so a count survives its kind being ticked', async () => {
    render('?q=settings&kinds=document')
    const results = await screen.findByRole('list', { name: 'Results' })
    expect(within(results).getAllByRole('listitem')).toHaveLength(1)
    const rail = screen.getByRole('complementary', { name: 'Filters' })
    await waitFor(() =>
      expect(within(rail).getByRole('button', { name: /Open questions/ })).toHaveTextContent('1')
    )
    expect(within(rail).getByRole('button', { name: /Documents/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('puts the facets in the URL and sends them', async () => {
    const { urls } = render('?q=settings')
    await screen.findByRole('list', { name: 'Results' })
    fireEvent.click(await screen.findByRole('button', { name: /Pages/ }))
    fireEvent.click(screen.getByRole('button', { name: /Open questions/ }))
    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId('location').textContent ?? '')
      expect(params.get('kinds')).toBe('page,question')
    })
    await waitFor(() => {
      const last = urls.filter(u => u.searchParams.has('kinds')).at(-1)
      expect(last?.searchParams.get('kinds')).toBe('page,question')
      expect(last?.searchParams.get('q')).toBe('settings')
    })
  })

  it('says so when a provider did not answer, and when matching was by keyword only', async () => {
    render('?q=settings', {
      semantic: 'unavailable',
      degraded: [{ provider: 'acme:questions', reason: 'timeout' }],
    })
    const notices = await screen.findAllByRole('status')
    expect(notices.map(n => n.textContent)).toEqual([
      expect.stringContaining('partial (Questions timed out)'),
      expect.stringContaining('keyword and name matches only'),
    ])
  })

  it('says how the list was ordered and marks each hit with how it was found', async () => {
    render('?q=settings')
    expect(await screen.findByTestId('ranking-summary')).toHaveTextContent(
      'Ranked by RRF over 3 lists · re-ranked by rerank-v3.5'
    )
    const rows = within(await screen.findByRole('list', { name: 'Results' })).getAllByRole(
      'listitem'
    )
    const first = within(rows[0] as HTMLElement).getByTestId('scoring-indicators')
    const move = first.querySelector('[data-move]') as HTMLElement
    expect(move).toHaveAttribute('data-move', 'up')
    expect(move).toHaveAttribute('title', 'Re-ranked by rerank-v3.5: score 0.930, from #2 to #1')
    const second = within(rows[1] as HTMLElement).getByTestId('scoring-indicators')
    expect(
      [...second.querySelectorAll('[data-signal]')].map(e => e.getAttribute('data-signal'))
    ).toEqual(['keyword', 'meaning'])
    expect(within(rows[2] as HTMLElement).queryByTestId('scoring-indicators')).toBeNull()
  })

  it('submitting the box sets ?q=', async () => {
    render('')
    expect(screen.getByText('Search for anything')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'invoice' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('q=invoice'))
  })
})
