/**
 * `/ideas-and-issues` — share an idea or flag a problem in your own words, and the agent takes it
 * from there. Below the box: everything you have shared, newest first, with its GitHub link once
 * logged.
 *
 * `?from=/some/path` (any page may link here with it) is recorded as where the person was.
 */

import { ChatBubbleLeftEllipsisIcon } from '@heroicons/react/24/outline'
import { type AgentRun, isRunActive } from '@rocketflare/shared/ai/agents'
import {
  ISSUE_REPORT_DESCRIPTION_MAX,
  issueReportInputSchema,
  issueReportOutputSchema,
} from '@rocketflare/shared/plugins/issue-reports/index'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  EmptyState,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
  timeAgo,
} from '@/plugins/api/ui'
import {
  useIssueReportsStatus,
  useMyIssueReports,
  useStartIssueReport,
} from '../hooks/useIssueReports'

function reportTitle(run: AgentRun): string {
  const output = issueReportOutputSchema.safeParse(run.output)
  if (output.success && output.data.title) return output.data.title
  const input = issueReportInputSchema.safeParse(run.input)
  const text = input.success ? input.data.description : 'Untitled'
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text
}

function ReportStatus({ run }: { run: AgentRun }) {
  const output = issueReportOutputSchema.safeParse(run.output)
  // A span, not a link: the whole row is already one. The GitHub link is on the report itself.
  if (output.success && output.data.issueNumber) {
    return <span className="badge badge-success badge-sm">#{output.data.issueNumber}</span>
  }
  if (run.status === 'awaiting_input') {
    return <span className="badge badge-warning badge-sm">Your turn</span>
  }
  if (isRunActive(run.status)) return <span className="badge badge-info badge-sm">Thinking</span>
  if (run.status === 'failed') return <span className="badge badge-error badge-sm">Failed</span>
  return <span className="badge badge-ghost badge-sm">Discarded</span>
}

export default function ReportIssuePage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [description, setDescription] = useState('')
  const [page, setPage] = useState(1)
  const status = useIssueReportsStatus()
  const reports = useMyIssueReports(page)
  const start = useStartIssueReport()

  const from = params.get('from')
  const pagePath = from?.startsWith('/') ? from.slice(0, 300) : undefined
  const configured = status.data?.configured ?? true

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const input = issueReportInputSchema.safeParse({ description, pagePath })
    if (!input.success) return
    start.mutate(input.data, { onSuccess: run => navigate(`/ideas-and-issues/${run.id}`) })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ideas & issues"
        description="Got an idea to make the app better, or found something broken or confusing? Describe it and the assistant will ask a few questions, then pass it to the developers on GitHub once you’ve checked the write-up."
      />

      {!configured && (
        <div role="alert" className="alert alert-warning">
          Ideas & issues is not set up on this deployment yet — an administrator needs to add the
          GitHub repository and token.
        </div>
      )}

      <SectionPanel title="What’s on your mind?">
        <form onSubmit={submit} className="space-y-3">
          <textarea
            className="textarea textarea-bordered w-full min-h-32"
            placeholder="e.g. It would help to filter the calendar by owner — or: when I move an order, the calendar still shows it on the old day until I refresh."
            value={description}
            maxLength={ISSUE_REPORT_DESCRIPTION_MAX}
            onChange={event => setDescription(event.target.value)}
            aria-label="Describe your idea or issue"
            disabled={!configured}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-base-content/60">
              {pagePath ? `From ${pagePath}. ` : ''}Nothing is logged until you approve it.
            </span>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!configured || !description.trim() || start.isPending}
            >
              {start.isPending ? 'Starting…' : 'Start'}
            </button>
          </div>
        </form>
      </SectionPanel>

      <SectionPanel title="Shared by you" flush>
        {reports.isLoading ? (
          <SkeletonRows rows={3} className="p-4" />
        ) : !reports.data?.items.length ? (
          <EmptyState
            icon={ChatBubbleLeftEllipsisIcon}
            message="Nothing shared yet"
            description="Ideas and issues you share show up here, with their GitHub link once logged."
            size="sm"
          />
        ) : (
          <ul className="divide-y divide-base-200">
            {reports.data.items.map(run => (
              <li key={run.id}>
                <Link
                  to={`/ideas-and-issues/${run.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-base-200/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{reportTitle(run)}</span>
                    <span className="text-xs text-base-content/60">{timeAgo(run.createdAt)}</span>
                  </span>
                  <ReportStatus run={run} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {reports.data && (
          <PaginationControls
            pagination={reports.data.pagination}
            onPageChange={setPage}
            className="px-4 pb-3"
          />
        )}
      </SectionPanel>
    </div>
  )
}
