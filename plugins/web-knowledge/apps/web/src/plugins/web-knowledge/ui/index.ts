/**
 * `web-knowledge` — UI entry. **Ships in the main bundle**, so it wires and renders nothing: the
 * settings page arrives through `lazy()`, and the only host module imported is the wiring half of
 * the UI kit.
 *
 * One tab, "Web search", in `/settings` — for anyone who may READ the configuration. The page
 * itself turns read-only for members; hiding it from them would leave them guessing why the
 * assistant can (or cannot) search the web.
 *
 * The lazy page gets its OWN `Suspense`: the nearest boundary otherwise is the whole settings
 * route, which would blank the tab strip while the chunk loads.
 */
import { GlobeAltIcon } from '@heroicons/react/24/outline'
import {
  WEB_SEARCH_CONFIG_SUBJECT,
  webKnowledgeShared,
} from '@rocketflare/shared/plugins/web-knowledge/index'
import { createElement, lazy, Suspense } from 'react'
import type { UiPlugin } from '@/plugins/api/ui-wiring'
import { webKnowledgeQueryKeys } from './query-keys'

const WebSearchSettingsPage = lazy(() => import('./pages/WebSearchSettings'))

export const webKnowledgeUi = {
  shared: webKnowledgeShared,
  routes: [],
  settingsTabs: ({ can }) =>
    can('read', WEB_SEARCH_CONFIG_SUBJECT)
      ? [
          {
            id: 'web-search',
            label: 'Web search',
            icon: createElement(GlobeAltIcon, { className: 'w-4 h-4' }),
            content: createElement(
              Suspense,
              { fallback: null },
              createElement(WebSearchSettingsPage)
            ),
          },
        ]
      : [],
  queryKeys: webKnowledgeQueryKeys,
} satisfies UiPlugin<typeof webKnowledgeShared>
