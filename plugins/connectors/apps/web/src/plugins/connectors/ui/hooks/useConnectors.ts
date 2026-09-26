/**
 * The data layer: `api.*` with the shared schema on every request, and mutations that invalidate
 * the family rather than writing into the cache.
 */
import {
  type CalendarEventListQuery,
  calendarEventListResponseSchema,
  connectorInstallationListResponseSchema,
  connectorProviderListResponseSchema,
  type StartInstallationRequest,
  type SyncInstallationRequest,
  startInstallationResponseSchema,
  syncInstallationResponseSchema,
} from '@rocketflare/shared/plugins/connectors/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/plugins/api/ui'
import { connectorsEventKeys, connectorsInstallationKeys } from '../query-keys'

const BASE = '/api/connectors'

export function useConnectorProviders() {
  return useQuery({
    queryKey: connectorsInstallationKeys.providers(),
    queryFn: () => api.get(`${BASE}/providers`, { schema: connectorProviderListResponseSchema }),
  })
}

export function useConnectorInstallations() {
  return useQuery({
    queryKey: connectorsInstallationKeys.list(),
    queryFn: () =>
      api.get(`${BASE}/installations`, { schema: connectorInstallationListResponseSchema }),
    // A first sync is a sequence of queue jobs; poll gently while one is running.
    refetchInterval: query =>
      query.state.data?.items.some(i => i.cursors.some(c => c.backfilling > 0)) ? 10_000 : false,
  })
}

export function useStartInstallation() {
  return useMutation({
    mutationFn: (body: StartInstallationRequest) =>
      api.post(`${BASE}/installations`, body, { schema: startInstallationResponseSchema }),
  })
}

export function useSyncInstallation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: SyncInstallationRequest & { id: string }) =>
      api.post(`${BASE}/installations/${id}/sync`, body, {
        schema: syncInstallationResponseSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectorsInstallationKeys.all }),
  })
}

export function useDeleteInstallation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/installations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectorsInstallationKeys.all }),
  })
}

export function useCalendarEvents(range: Pick<CalendarEventListQuery, 'from' | 'to'>) {
  const from = range.from.toISOString()
  const to = range.to.toISOString()
  return useQuery({
    queryKey: connectorsEventKeys.window(from, to),
    queryFn: () =>
      api.get(`${BASE}/events?${new URLSearchParams({ from, to })}`, {
        schema: calendarEventListResponseSchema,
      }),
  })
}
