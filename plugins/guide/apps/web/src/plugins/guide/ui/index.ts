/**
 * `guide` — the UI entry (D31). Ships in the main bundle, so it wires and nothing else: the lazy
 * reader at `/guide`, a nav item and a Home link, the header's `?` button (its own lazy chunk) and
 * the query families. No guard: every signed-in member of an organisation reads the guide (the
 * server decides which pages); the shell already requires sign-in and a tenant.
 */
import { BookOpenIcon } from '@heroicons/react/24/outline'
import { guideShared } from '@rocketflare/shared/plugins/guide/index'
import { lazy } from 'react'
import type { UiPlugin } from '@/plugins/api/ui-wiring'
import { guideQueryKeys } from './query-keys'

const GuideReader = lazy(() => import('./pages/GuideReader'))
const GuideHeaderButton = lazy(() => import('./header/GuideHeaderButton'))

export const guideUi = {
  shared: guideShared,
  routes: [{ path: '/guide', Component: GuideReader }],
  nav: [
    {
      label: 'Help',
      before: 'Platform',
      items: [{ to: '/guide', label: 'User guide', icon: BookOpenIcon }],
    },
  ],
  homeLinks: [
    {
      to: '/guide',
      label: 'User guide',
      description: 'How to use this app, and Ask the Guide',
      icon: BookOpenIcon,
    },
  ],
  header: [{ id: 'ask', Component: GuideHeaderButton, placement: 'end' }],
  queryKeys: guideQueryKeys,
} satisfies UiPlugin<typeof guideShared>
