/**
 * `freeagent` — the UI entry (D31): one page (`/freeagent`), one nav item, one settings tab. Pages
 * are `lazy()` so none of this rides in the main bundle; the route, the nav item and the tab share
 * one guard, so a link never points at a page its reader cannot open.
 */
import { BanknotesIcon } from '@heroicons/react/24/outline'
import { FREEAGENT_SUBJECT, freeagentShared } from '@rocketflare/shared/plugins/freeagent/index'
import { createElement, lazy, Suspense } from 'react'
import type { NavGuard, UiPlugin } from '@/plugins/api/ui-wiring'
import { freeagentQueryKeys } from './query-keys'

const FreeAgentPage = lazy(() => import('./pages/FreeAgentPage'))
const FreeAgentSettingsPage = lazy(() => import('./pages/FreeAgentSettings'))

const readFreeAgent: NavGuard = { action: 'read', subject: FREEAGENT_SUBJECT }

export const freeagentUi = {
  shared: freeagentShared,
  routes: [{ path: '/freeagent', Component: FreeAgentPage, guard: readFreeAgent }],
  nav: [
    {
      items: [{ to: '/freeagent', label: 'FreeAgent', icon: BanknotesIcon, guard: readFreeAgent }],
    },
  ],
  settingsTabs: ({ can }) =>
    can('read', FREEAGENT_SUBJECT)
      ? [
          {
            id: 'freeagent',
            label: 'FreeAgent',
            icon: createElement(BanknotesIcon, { className: 'w-4 h-4' }),
            content: createElement(
              Suspense,
              { fallback: null },
              createElement(FreeAgentSettingsPage)
            ),
          },
        ]
      : [],
  queryKeys: freeagentQueryKeys,
} satisfies UiPlugin<typeof freeagentShared>
