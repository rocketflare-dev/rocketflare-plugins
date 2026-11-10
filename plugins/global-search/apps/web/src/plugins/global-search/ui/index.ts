/**
 * `global-search` — UI entry. **Ships in the main bundle**, so it wires and renders nothing: the
 * header trigger, the results page and the settings tab each arrive through `lazy()`, and the
 * only host modules imported are the wiring half of the UI kit and the plugin types.
 *
 * - `header`: the search box in the middle of the top bar, for every signed-in member (the
 *   providers decide what each reader may find, server-side). It loads the palette on first use.
 * - `routes`: `/search/all`, the full results page the palette's "Search everything" row opens.
 * - `settingsTabs`: Settings → Search, the re-ranker, for whoever may manage it (owners, admins).
 */
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import {
  GLOBAL_SEARCH_CONFIG_SUBJECT,
  GLOBAL_SEARCH_PAGE_PATH,
  globalSearchShared,
} from '@rocketflare/shared/plugins/global-search/index'
import { createElement, lazy, Suspense } from 'react'
import type { UiPlugin } from '@/plugins/api/ui-wiring'
import { globalSearchQueryKeys } from './query-keys'

const GlobalSearchTrigger = lazy(() => import('./header/GlobalSearchTrigger'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const SearchSettingsPage = lazy(() => import('./pages/SearchSettings'))

export const globalSearchUi = {
  shared: globalSearchShared,
  routes: [{ path: GLOBAL_SEARCH_PAGE_PATH, Component: SearchPage }],
  header: [{ id: 'search', Component: GlobalSearchTrigger, placement: 'center' }],
  settingsTabs: ({ can }) =>
    can('manage', GLOBAL_SEARCH_CONFIG_SUBJECT)
      ? [
          {
            id: 'search',
            label: 'Search',
            icon: createElement(MagnifyingGlassIcon, { className: 'w-4 h-4' }),
            content: createElement(Suspense, { fallback: null }, createElement(SearchSettingsPage)),
          },
        ]
      : [],
  queryKeys: globalSearchQueryKeys,
} satisfies UiPlugin<typeof globalSearchShared>
