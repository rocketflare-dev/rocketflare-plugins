/**
 * `connectors` — UI entry. **Ships in the main bundle**, so it wires and renders nothing: both pages
 * arrive through `lazy()`, and the only host module imported is the wiring half of the UI kit.
 *
 * Two surfaces:
 *
 * - Settings → **Connections**, for anyone who may `read Connector` (owner, admin, support): connect
 *   a provider, watch the sync, disconnect. Read-only without `manage`.
 * - **My calendar**, for every member while the flag is on: the events synced from THEIR mailbox.
 *   The server returns only their own rows whatever the page asks for.
 *
 * Each lazy page gets its OWN `Suspense` where it renders inside the settings layout, so the tab
 * strip never blanks while a chunk loads.
 */
import { CalendarDaysIcon, LinkIcon } from '@heroicons/react/24/outline'
import {
  CONNECTOR_SUBJECT,
  CONNECTORS_FLAG,
  connectorsShared,
} from '@rocketflare/shared/plugins/connectors/index'
import { createElement, lazy, Suspense } from 'react'
import type { NavGuard, UiPlugin } from '@/plugins/api/ui-wiring'
import { connectorsQueryKeys } from './query-keys'

const ConnectionsSettingsPage = lazy(() => import('./pages/ConnectionsSettings'))
const MyCalendarPage = lazy(() => import('./pages/MyCalendarPage'))

/** One const for the nav item and the route, so a link never points at a page that refuses. */
export const CONNECTORS_CALENDAR_GUARD: NavGuard = { feature: CONNECTORS_FLAG }

export const connectorsUi = {
  shared: connectorsShared,
  routes: [{ path: '/calendar', Component: MyCalendarPage, guard: CONNECTORS_CALENDAR_GUARD }],
  nav: [
    {
      items: [
        {
          to: '/calendar',
          label: 'My calendar',
          icon: CalendarDaysIcon,
          guard: CONNECTORS_CALENDAR_GUARD,
        },
      ],
    },
  ],
  settingsTabs: ({ can }) =>
    can('read', CONNECTOR_SUBJECT)
      ? [
          {
            id: 'connections',
            label: 'Connections',
            icon: createElement(LinkIcon, { className: 'w-4 h-4' }),
            content: createElement(
              Suspense,
              { fallback: null },
              createElement(ConnectionsSettingsPage)
            ),
          },
        ]
      : [],
  queryKeys: connectorsQueryKeys,
} satisfies UiPlugin<typeof connectorsShared>
