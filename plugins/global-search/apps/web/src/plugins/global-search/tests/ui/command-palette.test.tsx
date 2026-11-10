/**
 * The ⌘K palette: Ctrl-K / ⌘K and the header button open it; typing searches
 * `GET /api/global-search` (debounced) and groups the hits by kind in the providers' order, with
 * their labels and badges; arrows move the active option (`aria-activedescendant`), Enter
 * navigates and remembers the hit under `global-search:recent`; an empty box offers the recent
 * ones; Tab never leaves the box; Escape closes and gives focus back; a partial answer says so.
 */

import { SEARCH_COMMANDS_EXTENSION } from '@rocketflare/shared/plugins/global-search/index'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { makeSession, makeTenant, renderWithProviders, stubFetch } from '@testkit/integration'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uiExtensionSources, uiExtensions } from '@/plugins/api/ui'
import { parseCommands } from '../../ui/goto'
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
  hit('page', 'Orders', '/orders', 'acme:pages'),
  hit('ticket', 'Order stuck in review', '/acme/T-1', 'acme:tickets'),
  hit('document', 'Order glossary', '/documents/d2', 'global-search:documents'),
]

const PROVIDERS = {
  providers: [
    {
      id: 'acme:pages',
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

function setup(
  degraded: { provider: string; reason: string }[] = [],
  session: ReturnType<typeof makeSession> = makeSession()
) {
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
    { session }
  )
  return { queries }
}

const input = () => screen.findByRole('combobox', { name: 'Search everything' })
const groupLabel = (g: HTMLElement) =>
  document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''

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
    const serverGroups = groups.filter(g => !['Go to', 'Commands'].includes(groupLabel(g)))
    expect(serverGroups.map(groupLabel)).toEqual(['Pages', 'Tickets', 'Documents'])
    expect(within(serverGroups[2] as HTMLElement).getAllByRole('option')).toHaveLength(2)
    // Badges and tones come from the registered kinds.
    const ticket = within(serverGroups[1] as HTMLElement).getByRole('option')
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

    // Reopened empty, it offers what was opened before, then places to go.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const [recent, goTo] = await screen.findAllByRole('group')
    expect(recent).toHaveTextContent('Recent')
    expect(goTo).toHaveTextContent('Go to')
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

  it('offers places to go and commands at once, before the server answers', async () => {
    const { queries } = setup()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await input(), { target: { value: 'sett' } })
    // No debounce, no request: the first group is already there.
    const goTo = screen.getAllByRole('group')[0] as HTMLElement
    expect(groupLabel(goTo)).toBe('Go to')
    expect(queries).toEqual([])
    const labels = within(goTo)
      .getAllByRole('option')
      .map(o => o.textContent)
    expect(labels[0]).toContain('Settings')
    expect(labels.some(l => l?.includes('People'))).toBe(true)

    fireEvent.change(await input(), { target: { value: 'inv' } })
    const commands = screen.getAllByRole('group').find(g => groupLabel(g) === 'Commands')
    expect(commands).toHaveTextContent('Invite people')
  })

  it('opens a destination with the keyboard', async () => {
    setup()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const box = await input()
    fireEvent.change(box, { target: { value: 'api keys' } })
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('API keys')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=api-keys')
    )
  })

  it('offers a member neither the settings tabs nor the admin commands', async () => {
    setup([], makeSession({ tenant: makeTenant({ role: 'member' }) }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await input(), { target: { value: 'inv' } })
    expect(screen.queryByText('Invite people')).toBeNull()
    fireEvent.change(await input(), { target: { value: 'sett' } })
    expect(screen.queryByText('People')).toBeNull()
    fireEvent.change(await input(), { target: { value: 'new chat' } })
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('New chat')
  })

  it('every installed command parses — the gate catches what the palette would drop', () => {
    const { commands, errors } = parseCommands(
      uiExtensions(SEARCH_COMMANDS_EXTENSION),
      uiExtensionSources(SEARCH_COMMANDS_EXTENSION)
    )
    expect(errors).toEqual([])
    expect(commands.map(c => c.id)).toContain('global-search:new-chat')
  })
})
