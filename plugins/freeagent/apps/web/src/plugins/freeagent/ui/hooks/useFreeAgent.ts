import {
  type FreeAgentInvoiceListQuery,
  type FreeAgentTransactionListQuery,
  freeagentConnectResponseSchema,
  freeagentInvoiceListResponseSchema,
  freeagentStatusSchema,
  freeagentSyncResponseSchema,
  freeagentTransactionListResponseSchema,
} from '@rocketflare/shared/plugins/freeagent/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/plugins/api/ui'
import { freeagentBooksKeys, freeagentConnectionKeys } from '../query-keys'

const BASE = '/api/freeagent'

function params(query: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) p.set(k, String(v))
  return p.toString()
}

export function useFreeAgentStatus() {
  return useQuery({
    queryKey: freeagentConnectionKeys.status(),
    queryFn: () => api.get(`${BASE}/status`, { schema: freeagentStatusSchema }),
  })
}

export function useConnectFreeAgent() {
  return useMutation({
    mutationFn: () => api.post(`${BASE}/connect`, {}, { schema: freeagentConnectResponseSchema }),
  })
}

export function useDisconnectFreeAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete(`${BASE}/connection`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: freeagentConnectionKeys.all })
      await queryClient.invalidateQueries({ queryKey: freeagentBooksKeys.all })
    },
  })
}

export function useSyncFreeAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post(`${BASE}/sync`, {}, { schema: freeagentSyncResponseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: freeagentConnectionKeys.all }),
  })
}

export function useFreeAgentTransactions(
  query: Partial<Record<keyof FreeAgentTransactionListQuery, unknown>>
) {
  return useQuery({
    queryKey: freeagentBooksKeys.transactions(query),
    queryFn: () =>
      api.get(`${BASE}/transactions?${params(query)}`, {
        schema: freeagentTransactionListResponseSchema,
      }),
  })
}

export function useFreeAgentInvoices(
  query: Partial<Record<keyof FreeAgentInvoiceListQuery, unknown>>
) {
  return useQuery({
    queryKey: freeagentBooksKeys.invoices(query),
    queryFn: () =>
      api.get(`${BASE}/invoices?${params(query)}`, { schema: freeagentInvoiceListResponseSchema }),
  })
}
