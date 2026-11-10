/**
 * `global-search:nav` — the app's own pages by name, so "settings" or "agents" jumps straight
 * there. A name match over a STATIC list of the kit's core pages, each behind the same guard its
 * nav item carries.
 *
 * Static because the kit exposes its navigation (`navigationConfig`, plugins' `nav` groups) only to
 * the browser, and to a plugin's UI entry rather than its lazy pages; the server, where providers
 * run, cannot see it. So other plugins' pages appear here only through their own providers.
 */
import type { SearchProvider, SearchProviderCtx } from '../types'

export const NAV_PROVIDER_ID = 'global-search:nav'
export const PAGE_KIND = 'page'

export interface NavEntry {
  title: string
  href: string
  /** Other words it answers to. */
  keywords?: readonly string[]
  /** Who may open it: a CASL pair, or `admin` (owner or admin). Absent = every member. */
  guard?: { action: string; subject: string } | 'admin'
}

/** The kit's core pages, with the guards `CORE_NAVIGATION` and `App.tsx` give them. */
export const CORE_PAGES: readonly NavEntry[] = [
  { title: 'Home', href: '/', keywords: ['dashboard', 'start'] },
  {
    title: 'Chat',
    href: '/chat',
    keywords: ['assistant', 'conversation', 'ask'],
    guard: { action: 'read', subject: 'Conversation' },
  },
  {
    title: 'Agents',
    href: '/agents',
    keywords: ['runs', 'automation'],
    guard: { action: 'read', subject: 'AgentRun' },
  },
  {
    title: 'Knowledge',
    href: '/documents',
    keywords: ['documents', 'files', 'upload'],
    guard: { action: 'read', subject: 'Document' },
  },
  {
    title: 'Knowledge search',
    href: '/search',
    keywords: ['passages'],
    guard: { action: 'read', subject: 'Document' },
  },
  { title: 'Search everything', href: '/search/all', keywords: ['find'] },
  { title: 'Notifications', href: '/notifications', keywords: ['alerts', 'inbox'] },
  { title: 'Profile', href: '/profile', keywords: ['account', 'me', 'preferences'] },
  {
    title: 'Settings',
    href: '/settings',
    keywords: ['organisation', 'members', 'configuration'],
    guard: 'admin',
  },
  { title: 'Activity', href: '/activity', keywords: ['audit', 'log', 'history'], guard: 'admin' },
]

function allowed(ctx: SearchProviderCtx, entry: NavEntry): boolean {
  if (!entry.guard) return true
  if (entry.guard === 'admin') return ctx.isAdmin
  return ctx.can(entry.guard.action, entry.guard.subject)
}

/** 3 = the title is the query, 2 = it starts with it, 1 = a word or keyword starts with it. Pure. */
export function navScore(entry: NavEntry, q: string): number {
  const query = q.trim().toLowerCase()
  if (!query) return 0
  const title = entry.title.toLowerCase()
  if (title === query) return 3
  if (title.startsWith(query)) return 2
  const words = [...title.split(/\s+/), ...(entry.keywords ?? []).map(k => k.toLowerCase())]
  return words.some(w => w.startsWith(query)) ? 1 : 0
}

export function navProviderFor(pages: readonly NavEntry[]): SearchProvider {
  return {
    id: NAV_PROVIDER_ID,
    label: 'Pages',
    kinds: [{ kind: PAGE_KIND, label: 'Pages', badge: 'page', tone: 'accent', order: 0 }],
    async search(ctx, input) {
      return pages
        .filter(p => allowed(ctx, p))
        .map(p => ({ page: p, score: navScore(p, input.q) }))
        .filter(m => m.score > 0)
        .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
        .slice(0, input.pool)
        .map(({ page }) => ({
          kind: PAGE_KIND,
          title: page.title,
          snippet: null,
          ref: page.href,
          href: page.href,
        }))
    },
  }
}

export const navProvider = navProviderFor(CORE_PAGES)
