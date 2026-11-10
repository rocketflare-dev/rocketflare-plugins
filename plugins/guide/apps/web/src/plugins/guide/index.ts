/**
 * `guide` — the SERVER entry (D31): an in-app user guide about the app itself.
 *
 * Read this file and you have the whole server half: the `/api/guide` mount (signed-in only; the
 * audience comes from the kit's admin-level check), the `guide.sync` job and its daily cron task
 * that index the bundle as PLATFORM documents, the "Ask the Guide" prompt, the `search_guide` tool
 * for every agent run, the platform sources the kit's own `search_knowledge` also covers, and a
 * structural provider for the `global-search` plugin. No table, no grants: the guide is the same
 * for every organisation and every member may read it.
 */
import {
  GUIDE_API_ROOT,
  GUIDE_PROMPT_KEY,
  GUIDE_SYNC_JOB,
  guideShared,
  guideSourcesFor,
} from '@rocketflare/shared/plugins/guide/index'
import type { ServerPlugin } from '@/plugins/api'
import { toolCtx } from '@/plugins/api'
import { guideRouter } from './api/routes'
import { guideBundle } from './content'
import { guidePrompt } from './prompts'
import { guideGlobalSearchProvider } from './services/global-search'
import { GUIDE_CRON, guideSyncTask, handleGuideSync } from './services/sync'
import { searchGuideTool } from './services/tools'

export const guideServer = {
  shared: guideShared,
  /** A getter, so the router is built once the plugin API has finished loading (see `api/routes`). */
  get mounts() {
    return [[GUIDE_API_ROOT, guideRouter()]] as const
  },
  jobHandlers: { [GUIDE_SYNC_JOB]: handleGuideSync },
  scheduledTasks: { [GUIDE_CRON]: [guideSyncTask] },
  prompts: { [GUIDE_PROMPT_KEY]: guidePrompt },
  /**
   * The kit's `search_knowledge` (chat and every agent run) also searches the guide, for the
   * reader's audience. `scope.bypass` is the kit's admin-level check (`isAdminLevel`).
   */
  knowledgeSources: scope => guideSourcesFor(scope.bypass),
  agentTools: raw => {
    const ctx = toolCtx(raw)
    const { config } = guideBundle()
    return [
      searchGuideTool(ctx, {
        isAdmin: ctx.scope.bypass,
        appName: config.appName,
        label: config.label,
      }),
    ]
  },
  extensions: { 'global-search.providers': [guideGlobalSearchProvider] },
} satisfies ServerPlugin<typeof guideShared>
