/**
 * The plugin's query families (D31). Every root starts with `issue-reports:`. The data is the
 * kit's agent runs, read through the kit's routes, but cached under these keys so this plugin's
 * polling never disturbs the Agents page's cache (and the other way round).
 */
const STATUS = 'issue-reports:status'
const REPORTS = 'issue-reports:reports'

export const issueReportsKeys = {
  status: [STATUS] as const,
  all: [REPORTS] as const,
  list: (page: number) => [REPORTS, 'list', page] as const,
  detail: (runId: string) => [REPORTS, 'detail', runId] as const,
}

export const issueReportsQueryKeys = {
  [STATUS]: { all: issueReportsKeys.status },
  [REPORTS]: issueReportsKeys,
} as const
