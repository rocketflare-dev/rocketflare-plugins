/**
 * A report IS an agent run of `issue-reports`, so these hooks are thin wrappers over the kit's
 * agent-run routes, parsed with the kit's own contracts. A conversation in progress is polled while
 * the agent is thinking (queued / running) and left alone while it waits on the person.
 */
import {
  type AgentRunWithEvents,
  agentRunSchema,
  agentRunWithEventsSchema,
  createAgentRunResponseSchema,
} from '@rocketflare/shared/ai/agents'
import { paginatedResponse } from '@rocketflare/shared/plugins/api'
import {
  ISSUE_REPORTS_AGENT_KEY,
  ISSUE_REPORTS_API_ROOT,
  type IssueReportInput,
  issueReportsStatusSchema,
} from '@rocketflare/shared/plugins/issue-reports/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/plugins/api/ui'
import { issueReportsKeys } from '../query-keys'

const RUNS = '/api/agents/runs'
const reportListSchema = paginatedResponse(agentRunSchema)

/** While the agent is working the answer is seconds away; while it waits, nothing changes. */
const POLL_MS = 1_500

export function useIssueReportsStatus() {
  return useQuery({
    queryKey: issueReportsKeys.status,
    queryFn: () =>
      api.get(`${ISSUE_REPORTS_API_ROOT}/status`, { schema: issueReportsStatusSchema }),
    staleTime: 5 * 60_000,
  })
}

export function useMyIssueReports(page = 1) {
  return useQuery({
    queryKey: issueReportsKeys.list(page),
    queryFn: () =>
      api.get(`${RUNS}?agentKey=${ISSUE_REPORTS_AGENT_KEY}&page=${page}&pageSize=20`, {
        schema: reportListSchema,
      }),
  })
}

const isThinking = (run: AgentRunWithEvents | undefined) =>
  run?.status === 'queued' || run?.status === 'running'

export function useIssueReport(runId: string) {
  return useQuery({
    queryKey: issueReportsKeys.detail(runId),
    queryFn: () => api.get(`${RUNS}/${runId}`, { schema: agentRunWithEventsSchema }),
    refetchInterval: query => (isThinking(query.state.data) ? POLL_MS : false),
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: issueReportsKeys.all })
}

export function useStartIssueReport() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: IssueReportInput) =>
      api.post(
        RUNS,
        { agentKey: ISSUE_REPORTS_AGENT_KEY, input },
        { schema: createAgentRunResponseSchema }
      ),
    onSuccess: invalidate,
  })
}

/** Answer the pending ask: `{ text }` for a question, `{ value }` for the draft review. */
export function useAnswerIssueReport(runId: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (answer: { interruptId: string; payload: { text: string } | { value: string } }) =>
      api.post(`${RUNS}/${runId}/interrupts/${answer.interruptId}`, {
        status: 'resolved',
        payload: answer.payload,
      }),
    onSuccess: invalidate,
  })
}

export function useDiscardIssueReport(runId: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: () => api.post(`${RUNS}/${runId}/cancel`),
    onSuccess: invalidate,
  })
}
