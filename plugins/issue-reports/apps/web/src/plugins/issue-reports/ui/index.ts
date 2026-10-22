/**
 * `issue-reports` — the UI entry (D31). Ships in the main bundle, so it wires and nothing else:
 * two lazy pages and one nav item. The guard is the kit's own "may start an agent run",
 * which every role has — anyone on the team can share an idea or flag a problem.
 */
import { LightBulbIcon } from '@heroicons/react/24/outline'
import { issueReportsShared } from '@rocketflare/shared/plugins/issue-reports/index'
import { lazy } from 'react'
import type { NavGuard, UiPlugin } from '@/plugins/api/ui-wiring'
import { issueReportsQueryKeys } from './query-keys'

const ReportIssuePage = lazy(() => import('./pages/ReportIssuePage'))
const ReportConversationPage = lazy(() => import('./pages/ReportConversationPage'))

export const ISSUE_REPORTS_GUARD: NavGuard = { action: 'create', subject: 'AgentRun' }

export const issueReportsUi = {
  shared: issueReportsShared,
  routes: [
    { path: '/ideas-and-issues', Component: ReportIssuePage, guard: ISSUE_REPORTS_GUARD },
    {
      path: '/ideas-and-issues/:runId',
      Component: ReportConversationPage,
      guard: ISSUE_REPORTS_GUARD,
    },
  ],
  // Its own group, after the kit's last one: it is about the app, not part of the work in it.
  nav: [
    {
      label: 'Feedback',
      before: 'Platform',
      items: [
        {
          to: '/ideas-and-issues',
          label: 'Ideas & issues',
          icon: LightBulbIcon,
          guard: ISSUE_REPORTS_GUARD,
        },
      ],
    },
  ],
  queryKeys: issueReportsQueryKeys,
} satisfies UiPlugin<typeof issueReportsShared>
