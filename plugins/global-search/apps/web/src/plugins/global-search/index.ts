/**
 * `global-search` — SERVER entry.
 *
 * One mount (`/api/global-search`), one CASL subject for the re-ranker settings, and the plugin's
 * own four providers (people, agents, the reader's chats, documents) registered exactly as any other plugin registers one: under
 * `extensions['global-search.providers']`. The route reads that key across every installed plugin
 * (`services/registry.ts`), so the built-ins prove the path a third party takes.
 *
 * The provider types are exported for this plugin's own code and tests; another plugin never
 * imports them (it would not compile without this plugin installed) — it declares an object of
 * the same shape. `docs/plugin-api` has nothing to add: the contract is this plugin's, published
 * in `@rocketflare/shared/plugins/global-search`.
 */
import {
  GLOBAL_SEARCH_CONFIG_SUBJECT,
  globalSearchShared,
  SEARCH_PROVIDERS_EXTENSION,
} from '@rocketflare/shared/plugins/global-search/index'
import type { ServerPlugin } from '@/plugins/api'
import { globalSearchRouter } from './api/router'
import { agentsProvider } from './providers/agents'
import { chatsProvider } from './providers/chats'
import { documentsProvider } from './providers/documents'
import { peopleProvider } from './providers/people'

export type { SearchProvider, SearchProviderCtx } from './types'

export const globalSearchServer = {
  shared: globalSearchShared,
  mounts: [['/api/global-search', globalSearchRouter]],
  extensions: {
    [SEARCH_PROVIDERS_EXTENSION]: [
      peopleProvider,
      agentsProvider,
      chatsProvider,
      documentsProvider,
    ],
  },
  /** Additive, over this plugin's own subject: owners and admins configure the re-ranker. */
  grants: {
    owner: can => can('manage', GLOBAL_SEARCH_CONFIG_SUBJECT),
    admin: can => can('manage', GLOBAL_SEARCH_CONFIG_SUBJECT),
  },
} satisfies ServerPlugin<typeof globalSearchShared>
