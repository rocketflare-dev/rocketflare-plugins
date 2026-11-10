/**
 * The guide as the server reads it: the generated bundle (`@/host/guide/content.generated`, the
 * developer's file, rebuilt by `guide-build.mjs`) and THE audience rule over it.
 *
 * The audience is applied here, once: `guideTocFor` filters the pages a reader may see, and every
 * route resolves a path through that list — so an admin page is the same 404 to a member as a page
 * that does not exist, not merely unlisted.
 */
import {
  type GuideBundle,
  type GuideBundlePage,
  type GuideTocEntry,
  visibleAudiences,
} from '@rocketflare/shared/plugins/guide/index'
import { GUIDE_BUNDLE } from '@/host/guide/content.generated'

/** The bundle this deployment shipped. */
export function guideBundle(): GuideBundle {
  return GUIDE_BUNDLE
}

export function tocEntryFor(page: GuideBundlePage): GuideTocEntry {
  const f = page.frontmatter
  return {
    path: page.path,
    title: f.title,
    part: f.part,
    section: f.section,
    order: f.order,
    summary: f.summary,
    audience: f.audience,
  }
}

export interface GuideView {
  /** In reading order (the bundle is sorted by the build). */
  entries: GuideTocEntry[]
  pages: ReadonlyMap<string, GuideBundlePage>
}

const views = new WeakMap<GuideBundle, Map<boolean, GuideView>>()

/** What a reader sees: admins every page, everyone else member pages. */
export function guideViewFor(isAdmin: boolean, bundle: GuideBundle = guideBundle()): GuideView {
  let byAudience = views.get(bundle)
  if (!byAudience) {
    byAudience = new Map()
    views.set(bundle, byAudience)
  }
  const cached = byAudience.get(isAdmin)
  if (cached) return cached
  const audiences = visibleAudiences(isAdmin)
  const visible = bundle.pages.filter(p => audiences.includes(p.frontmatter.audience))
  const view: GuideView = {
    entries: visible.map(tocEntryFor),
    pages: new Map(visible.map(p => [p.path, p])),
  }
  byAudience.set(isAdmin, view)
  return view
}

/**
 * The page that explains the screen at `route`, through the config's `screens` (the longest
 * prefix that matches on a path-segment boundary, among the pages this reader may open). `/`
 * matches only the home screen itself.
 */
export function guideScreenPage(
  route: string,
  view: GuideView,
  bundle: GuideBundle = guideBundle()
): GuideBundlePage | null {
  const path = route.split(/[?#]/)[0] ?? route
  let best: { prefix: string; page: string } | null = null
  for (const [prefix, page] of Object.entries(bundle.config.screens)) {
    const bare = prefix.replace(/\/+$/, '') || '/'
    const matches = bare === '/' ? path === '/' : path === bare || path.startsWith(`${bare}/`)
    // Only pages this reader may open compete: a member on an admin screen gets a shorter match.
    if (!matches || !view.pages.has(page)) continue
    if (!best || bare.length > best.prefix.length) best = { prefix: bare, page }
  }
  return best ? (view.pages.get(best.page) ?? null) : null
}

/**
 * The screen as one line of system context: the page the config maps the route to, when this
 * reader may open it — a title and a path from the bundle, never anything from the URL.
 */
export function guideScreenContext(
  route: string | undefined,
  view: GuideView,
  bundle: GuideBundle = guideBundle()
): string | undefined {
  if (!route) return undefined
  const page = guideScreenPage(route, view, bundle)
  if (!page) return undefined
  return `The person is on the screen the guide page "${page.frontmatter.title}" (${page.path}) describes. When they ask what to do "here" or "now", answer about that screen first.`
}
