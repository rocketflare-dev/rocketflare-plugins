/**
 * `web-knowledge` — SERVER entry.
 *
 * Read top to bottom: one mount for the settings, one CASL subject, and two agent tools that only a
 * tenant with web search ON is offered. That last part is the plugin's reason to exist and the
 * reason it needs kit ≥ 0.9.0: `tools` is async there, so it reads this tenant's settings row
 * and returns `[]` when the organisation has not turned search on. A model is never shown a tool
 * that could only answer "not configured".
 *
 * The row is read on every chat turn and every run (one indexed lookup); the key is opened only
 * inside a tool's handler, when a call is actually made.
 */
import {
  WEB_SEARCH_CONFIG_SUBJECT,
  webKnowledgeShared,
} from '@rocketflare/shared/plugins/web-knowledge/index'
import type { ServerPlugin } from '@/plugins/api'
import { toolCtx } from '@/plugins/api'
import { webKnowledgeRouter } from './api/routes'
import { loadEnabledSearch } from './api/settings'
import { webTools } from './tools/web-tools'

export const webKnowledgeServer = {
  shared: webKnowledgeShared,
  mounts: [['/api/web-knowledge', webKnowledgeRouter]],
  tools: async raw => {
    const ctx = toolCtx(raw)
    const search = await loadEnabledSearch(ctx.db, ctx.tenantId)
    if (!search) return []
    return webTools(ctx, search)
  },
  /** Additive, over this plugin's own subject: admins configure, everyone may see what is set. */
  grants: {
    owner: can => can('manage', WEB_SEARCH_CONFIG_SUBJECT),
    admin: can => can('manage', WEB_SEARCH_CONFIG_SUBJECT),
    support: can => can('read', WEB_SEARCH_CONFIG_SUBJECT),
    member: can => can('read', WEB_SEARCH_CONFIG_SUBJECT),
  },
} satisfies ServerPlugin<typeof webKnowledgeShared>
