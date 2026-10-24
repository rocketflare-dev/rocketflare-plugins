import {
  type InboxMessageListQuery,
  inboxMessageListResponseSchema,
  inboxMessageSchema,
  inboxReprocessResponseSchema,
  inboxSettingsSchema,
  type UpdateInboxSettings,
} from '@rocketflare/shared/plugins/inbox/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/plugins/api/ui'
import { inboxMessageKeys, inboxSettingsKeys } from '../query-keys'

const BASE = '/api/inbox'

export function useInboxMessages(query: Partial<InboxMessageListQuery>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v))
  return useQuery({
    queryKey: inboxMessageKeys.list(query),
    queryFn: () =>
      api.get(`${BASE}/messages?${params.toString()}`, { schema: inboxMessageListResponseSchema }),
  })
}

export function useInboxMessage(id: string | null) {
  return useQuery({
    queryKey: inboxMessageKeys.detail(id ?? ''),
    queryFn: () => api.get(`${BASE}/messages/${id}`, { schema: inboxMessageSchema }),
    enabled: Boolean(id),
  })
}

export function useReprocessInboxMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`${BASE}/messages/${id}/reprocess`, {}, { schema: inboxReprocessResponseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inboxMessageKeys.all }),
  })
}

export function useDeleteInboxMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/messages/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inboxMessageKeys.all }),
  })
}

export function useInboxSettings() {
  return useQuery({
    queryKey: inboxSettingsKeys.all,
    queryFn: () => api.get(`${BASE}/settings`, { schema: inboxSettingsSchema }),
  })
}

export function useUpdateInboxSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateInboxSettings) =>
      api.put(`${BASE}/settings`, body, { schema: inboxSettingsSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inboxSettingsKeys.all }),
  })
}
