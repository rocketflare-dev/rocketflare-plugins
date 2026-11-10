/**
 * `search_guide` — how a model reads the user guide: in "Ask the Guide" (the only tool that chat
 * offers) and in every agent run (`agentTools`). The kit's own `search_knowledge` also covers the
 * guide through `knowledgeSources`; this tool is the guide-only search with citation keys.
 *
 * The model supplies only `query` and `topK`. The audience is fixed by the caller from the
 * reader's role, so nothing the model writes can widen what it reads.
 */
import { GUIDE_DEFAULT_TOP_K, GUIDE_MAX_TOP_K } from '@rocketflare/shared/plugins/guide/index'
import { z } from 'zod'
import { defineTool, type Tool } from '@/plugins/api'
import type { GuideView } from '../content'
import { type GuideSearchCtx, searchGuide } from './search'

export const SEARCH_GUIDE_TOOL = 'search_guide'

export const searchGuideInputSchema = z.object({
  query: z.string().trim().min(1).max(1000).describe('What to look for in the user guide.'),
  topK: z.coerce
    .number()
    .int()
    .min(1)
    .max(GUIDE_MAX_TOP_K)
    .optional()
    .describe(`How many passages to return (default ${GUIDE_DEFAULT_TOP_K}).`),
})

export interface SearchGuideToolOptions {
  isAdmin: boolean
  appName: string
  label: string
  view?: GuideView
  /** Each search's mode and passages: an answer says when it fell back to keywords, and cites. */
  onSearch?: (
    semantic: 'used' | 'unavailable',
    passages: Awaited<ReturnType<typeof searchGuide>>['passages']
  ) => void
}

/** The passages as the model reads them: each tagged with the page and heading to cite. */
export function renderPassages(
  passages: Awaited<ReturnType<typeof searchGuide>>['passages']
): string {
  if (passages.length === 0) return 'No passage of the guide matches. Try other words.'
  return passages
    .map(
      (p, i) =>
        `[${i + 1}] page=${p.path} | heading=${p.heading ?? '-'} | url=${p.href}\n${p.text.trim()}`
    )
    .join('\n\n---\n\n')
}

export function searchGuideTool(ctx: GuideSearchCtx, options: SearchGuideToolOptions): Tool {
  return defineTool({
    name: SEARCH_GUIDE_TOOL,
    description:
      `Search the ${options.label} of ${options.appName} — the app's own explanation of how to ` +
      'use it: its screens, workflows, settings and administration. Returns the most relevant ' +
      'passages, each tagged with its page path and heading for citation. Issue several focused ' +
      'queries to cover a question. Read-only.',
    schema: searchGuideInputSchema,
    async handler(input) {
      const { passages, semantic } = await searchGuide(ctx, {
        query: input.query,
        limit: input.topK ?? GUIDE_DEFAULT_TOP_K,
        isAdmin: options.isAdmin,
        view: options.view,
      })
      options.onSearch?.(semantic, passages)
      return renderPassages(passages)
    },
  }) as Tool
}
