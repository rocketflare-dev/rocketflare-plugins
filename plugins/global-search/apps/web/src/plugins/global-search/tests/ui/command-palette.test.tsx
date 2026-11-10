/**
 * The ⌘K palette: Ctrl-K / ⌘K and the header button open it; typing searches
 * `GET /api/global-search` (debounced) and groups the hits by kind in the providers' order, with
 * their labels and badges; arrows move the active option (`aria-activedescendant`), Enter
 * navigates and remembers the hit under `global-search:recent`; an empty box offers the recent
 * ones; Tab never leaves the box; Escape closes and gives focus back; a partial answer says so.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { makeSession, renderWithProviders, stubFetch } from '@testkit/integration'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import GlobalSearchTrigger from '../../ui/header/GlobalSearchTrigger'
import { RECENT_KEY } from '../../ui/searchModel'

const hit = (kind: string, title: string, href: string, provider: string) => ({
  kind,
  title,
  snippet: null,
  ref: `${kind}:${title}`,
  href,
  provider,
  score: 0.01,
})

const HITS = [
  hit('document', 'Order handbook', '/documents/d1?offset=0&q=order', 'global-search:documents'),
  hit('page', 'Orders', '/orders', 'global-search:nav'),
  hit('ticket', 'Order stuck in review', '/acme/T-1', 'acme:tickets'),
  hit('document', 'Order glossary', '/documents/d2', 'global-search:documents'),
]

const PROVIDERS = {
  providers: [
    {
      id: 'global-search:nav',
      label: 'Pages',
      kinds: [{ kind: 'page', label: 'Pages', badge: 'page', tone: 'accent', order: 0 }],
    },
    {
      id: 'acme:tickets',
      label: 'Tickets',
      kinds: [{ kind: 'ticket', label: 'Tickets', badge: 'ticket', tone: 'warning', order: 20 }],
    },
    {
      id: 'global-search:documents',
      label: 'Knowledge base',
      kinds: [{ kind: 'document', label: 'Documents', badge: 'document', tone: 'info', order: 50 }],
    },
  ],
}

const RANKING = {
  method: 'rrf',
  k: 60,
  lists: 3,
  rerank: { applied: false, reason: 'not_configured' },
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

function setup(degraded: { provider: string; reason: string }[] = []) {
  const queries: string[] = []
  stubFetch({
    '/api/global-search': (_init: RequestInit | undefined, url: URL) => {
      queries.push(url.searchParams.get('q') ?? '')
      return { items: HITS, semantic: 'used', degraded, ranking: RANKING }
    },
    '/api/global-search/providers': PROVIDERS,
  })
  renderWithProviders(
    <>
      <GlobalSearchTrigger />
      <LocationProbe />
    </>,
    { session: makeSession() }
  )
  return { queries }
}

const input = () => screen.findByRole('combobox', { name: 'Search everything' })

beforeEach(() => localStorage.removeItem(RECENT_KEY))
afterEach(() => localStorage.removeItem(RECENT_KEY))

describe('the command palette', () => {
  it('opens on Ctrl-K and on ⌘K', async () => {
    setup()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(await input()).toHaveFocus()
    fireEvent.keyDown(await input(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'K', metaKey: true })
    expect(await input()).toBeInTheDocument()
  })

  it('searches after a pause and groups the hits in the providers’ kind order', async () => {
    const { queries } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(await input(), { target: { value: 'ord' } })
    fireEvent.change(await input(), { target: { value: 'order' } })
    const groups = await screen.findAllByRole('group')
    expect(queries).toEqual(['order']) // debounced: one request for the settled text
    expect(
      groups.map(g => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent)
    ).toEqual(['Pages', 'Tickets', 'Documents'])
    expect(within(groups[2] as HTMLElement).getAllByRole('option')).toHaveLength(2)
    // Badges and tones come from the registered kinds.
    const ticket = within(groups[1] as HTMLElement).getByRole('option')
    expect(ticket.querySelector('[data-kind="ticket"]')).toHaveAttribute('data-tone', 'warning')
    expect(ticket).toHaveTextContent('ticket')
    // The last option hands off to the full results page.
    expect(screen.getAllByRole('option').at(-1)).toHaveTextContent('Search everything for “order”')
  })

  it('moves with the arrows, opens with Enter and remembers the hit', async () => {
    setup()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const box = await input()
    fireEvent.change(box, { target: { value: 'order' } })
    await screen.findAllByRole('group')
    const options = screen.getAllByRole('option')
    expect(box).toHaveAttribute('aria-activedescendant', options[0]?.id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box).toHaveAttribute('aria-activedescendant', options[2]?.id)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/acme/T-1'))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('global-search:recent') ?? '[]')[0]).toMatchObject({
      href: '/acme/T-1',
    })

    // Reopened empty, it offers what was opened before.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const recent = await screen.findByRole('group')
    expect(recent).toHaveTextContent('Recent')
    expect(within(recent).getByRole('option')).toHaveTextContent('Order stuck in review')
  })

  it('wraps around, and ArrowUp from the first option lands on "Search everything"', async () => {
    setup()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const box = await input()
    fireEvent.change(box, { target: { value: 'order' } })
    await screen.findAllByRole('group')
    const options = screen.getAllByRole('option')
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box).toHaveAttribute('aria-activedescendant', options.at(-1)?.id)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/search/all?q=order')
    )
  })

  it('keeps focus in the box on Tab, and gives it back on Escape', async () => {
    setup()
    const trigger = screen.getByRole('button', { name: 'Search' })
    trigger.focus()
    fireEvent.click(trigger)
    const box = await input()
    fireEvent.keyDown(box, { key: 'Tab' })
    expect(box).toHaveFocus()
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    expect(box).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Search' })).toHaveAttribute('aria-modal', 'true')
    fireEvent.keyDown(box, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('says when the answer is partial', async () => {
    setup([{ provider: 'acme:tickets', reason: 'timeout' }])
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await input(), { target: { value: 'order' } })
    const badge = await screen.findByText('Partial results')
    expect(badge).toHaveAttribute('title', 'Tickets timed out')
  })
})
