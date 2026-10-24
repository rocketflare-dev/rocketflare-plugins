/**
 * `inbox` — the UI entry (D31): one page (`/inbox`), one nav item, one settings tab. Pages are
 * `lazy()` so none of this rides in the main bundle.
 */
import { EnvelopeIcon } from '@heroicons/react/24/outline'
import {
  INBOX_MESSAGE_SUBJECT,
  INBOX_SETTINGS_SUBJECT,
  inboxShared,
} from '@rocketflare/shared/plugins/inbox/index'
import { createElement, lazy, Suspense } from 'react'
import type { NavGuard, UiPlugin } from '@/plugins/api/ui-wiring'
import { inboxQueryKeys } from './query-keys'

const InboxPage = lazy(() => import('./pages/InboxPage'))
const InboxSettingsPage = lazy(() => import('./pages/InboxSettings'))

const readInbox: NavGuard = { action: 'read', subject: INBOX_MESSAGE_SUBJECT }

export const inboxUi = {
  shared: inboxShared,
  routes: [{ path: '/inbox', Component: InboxPage, guard: readInbox }],
  nav: [{ items: [{ to: '/inbox', label: 'Inbox', icon: EnvelopeIcon, guard: readInbox }] }],
  settingsTabs: ({ can }) =>
    can('read', INBOX_SETTINGS_SUBJECT)
      ? [
          {
            id: 'inbox',
            label: 'Inbox',
            icon: createElement(EnvelopeIcon, { className: 'w-4 h-4' }),
            content: createElement(Suspense, { fallback: null }, createElement(InboxSettingsPage)),
          },
        ]
      : [],
  queryKeys: inboxQueryKeys,
} satisfies UiPlugin<typeof inboxShared>
