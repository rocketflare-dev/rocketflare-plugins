/**
 * `/api/guide` — the user guide, for any signed-in member of the organisation (a session or an
 * API key; the mount sits behind the kit's auth like every authed mount, so no credential is 401).
 *
 *   GET  /toc            the pages this reader may see, in reading order (+ the index state, admins)
 *   GET  /page?path=     one page: markdown (facts resolved) + outline
 *   GET  /search?q=      semantic + keyword search over the guide, one hit per page section
 *   POST /ask            "Ask the Guide": AG-UI stream, ending with CUSTOM `guide.answer`
 *
 * - **The audience is derived here, from role** (`ctx.isAdmin`, the kit's admin-level check). The
 *   client never sends it. A page outside the reader's audience is the same 404 as a missing one.
 * - **Nothing tenant-specific enters the chat.** The screen hint is a ROUTE the server maps to a
 *   page through the config's `screens`; the route itself never reaches the model.
 * - **Stateless.** An answer stores nothing but its usage row and its trace.
 * - **Every request checks the search index** (`ensureGuideIndex`, memoised per isolate) and
 *   enqueues `guide.sync` when the bundle or the platform model moved — it never syncs inline.
 */
import {
  type AskGuideRequest,
  askGuideSchema,
  GUIDE_ANSWER_EVENT,
  GUIDE_CHAT_FEATURE,
  GUIDE_MAX_TURNS,
  GUIDE_PROMPT_KEY,
  GUIDE_SEARCH_LIMIT,
  type GuideAnswer,
  type GuidePageResponse,
  type GuideSearchResponse,
  type GuideTocResponse,
  guidePageQuerySchema,
  guideSearchQuerySchema,
} from '@rocketflare/shared/plugins/guide/index'
import type { z } from 'zod'
import { createRouter, type RequestCtx, requestCtx, streamChat, validate } from '@/plugins/api'
import { guideBundle, guideScreenContext, guideViewFor } from '../content'
import {
  dedupeGuideCitations,
  resolveGuideCitation,
  searchedGuideCitations,
  splitGuideCitations,
} from '../services/citations'
import { searchGuide } from '../services/search'
import { ensureGuideIndex } from '../services/sync'
import { searchGuideTool } from '../services/tools'

/**
 * Built on first use, not at module scope: `@/plugins/api` can still be loading when the server
 * barrel imports this file, and a module-scope `createRouter()` would then be undefined.
 */
let router: ReturnType<typeof createRouter> | null = null
export function guideRouter(): ReturnType<typeof createRouter> {
  router ??= buildGuideRouter()
  return router
}

function buildGuideRouter(): ReturnType<typeof createRouter> {
  const guideRouter = createRouter()

  guideRouter.get('/toc', async c => {
    const ctx: RequestCtx = requestCtx(c)
    const bundle = guideBundle()
    const state = await ensureGuideIndex(ctx)
    const view = guideViewFor(ctx.isAdmin)
    const body: GuideTocResponse = {
      label: bundle.config.label,
      appName: bundle.config.appName,
      parts: bundle.config.parts,
      entries: view.entries,
      index: ctx.isAdmin ? state : null,
    }
    return c.json(body)
  })

  guideRouter.get('/page', validate('query', guidePageQuerySchema), async c => {
    const ctx: RequestCtx = requestCtx(c)
    const { path } = ctx.valid<z.infer<typeof guidePageQuerySchema>>('query')
    await ensureGuideIndex(ctx)
    // Resolved through the reader's OWN view: an admin page is unknown to a member.
    const view = guideViewFor(ctx.isAdmin)
    const page = view.pages.get(path)
    const meta = view.entries.find(e => e.path === path)
    if (!page || !meta) ctx.notFound('Unknown guide page', 'guide_page_not_found')
    const body: GuidePageResponse = {
      path,
      title: page.frontmatter.title,
      meta,
      markdown: page.markdown,
      outline: page.outline,
      calloutLabels: guideBundle().config.calloutLabels,
    }
    return c.json(body)
  })

  guideRouter.get('/search', validate('query', guideSearchQuerySchema), async c => {
    const ctx: RequestCtx = requestCtx(c)
    const { q } = ctx.valid<z.infer<typeof guideSearchQuerySchema>>('query')
    await ensureGuideIndex(ctx)
    const { passages, semantic } = await searchGuide(ctx, {
      query: q,
      limit: GUIDE_SEARCH_LIMIT,
      isAdmin: ctx.isAdmin,
      signal: c.req.raw.signal,
    })
    const body: GuideSearchResponse = {
      semantic,
      hits: passages.map(({ text: _text, denseRank: _d, lexicalRank: _l, ...hit }) => hit),
    }
    return c.json(body)
  })

  guideRouter.post('/ask', validate('json', askGuideSchema), async c => {
    const ctx: RequestCtx = requestCtx(c)
    const body = ctx.valid<AskGuideRequest>('json')
    await ensureGuideIndex(ctx)
    const bundle = guideBundle()
    const view = guideViewFor(ctx.isAdmin)
    let searches = 0
    let lexical = false
    const searched: { path: string; heading: string | null }[] = []
    return streamChat(c, {
      promptKey: GUIDE_PROMPT_KEY,
      feature: GUIDE_CHAT_FEATURE,
      variables: { appName: bundle.config.appName, guideLabel: bundle.config.label },
      system: guideScreenContext(body.screen?.route, view),
      history: body.history,
      message: body.question,
      maxTurns: GUIDE_MAX_TURNS,
      tools: toolCtx => [
        searchGuideTool(toolCtx, {
          isAdmin: ctx.isAdmin,
          appName: bundle.config.appName,
          label: bundle.config.label,
          view,
          onSearch: (semantic, passages) => {
            searches++
            if (semantic === 'unavailable') lexical = true
            searched.push(...passages)
          },
        }),
      ],
      onFinish: async (result, { emit }) => {
        const { answer, citations } = splitGuideCitations(result.text)
        const cited = dedupeGuideCitations(citations.map(cit => resolveGuideCitation(cit, view)))
        const done: GuideAnswer = {
          answer,
          // A model that wrote no CITATIONS block: show the sections its searches returned.
          citations: cited.length > 0 ? cited : searchedGuideCitations(searched, view),
          retrieval: searches === 0 ? 'none' : lexical ? 'lexical' : 'hybrid',
        }
        await emit(GUIDE_ANSWER_EVENT, done)
      },
    })
  })

  return guideRouter
}
