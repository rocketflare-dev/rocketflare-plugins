/**
 * The data layer: `api.*` with the shared schema on every request. The providers' metadata is
 * fetched once per session (`staleTime: Infinity`) — it changes only when the app is redeployed.
 */
import {
  globalSearchResultSchema,
  globalSearchSettingsSchema,
  searchProvidersResponseSchema,
  type TestRerankRequest,
  testRerankResponseSchema,
  type UpdateGlobalSearchSettings,
} from '@rocketflare/shared/plugins/global-search/index'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/plugins/api/ui'
import {
  type GlobalSearchParams,
  globalSearchKeys,
  globalSearchSettingsKeys,
  searchProvidersKeys,
} from '../query-keys'

const BASE = '/api/global-search'

export function useGlobalSearch(params: GlobalSearchParams, options: { enabled?: boolean } = {}) {
  const search = new URLSearchParams({ q: params.q })
  if (params.kinds?.length) search.set('kinds', params.kinds.join(','))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  return useQuery({
    queryKey: globalSearchKeys.query(params),
    queryFn: () => api.get(`${BASE}?${search}`, { schema: globalSearchResultSchema }),
    enabled: (options.enabled ?? true) && params.q.trim().length > 0,
    // The previous answer stays on screen while the next query loads.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useSearchProviders() {
  return useQuery({
    queryKey: searchProvidersKeys.all,
    queryFn: () => api.get(`${BASE}/providers`, { schema: searchProvidersResponseSchema }),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useGlobalSearchSettings() {
  return useQuery({
    queryKey: globalSearchSettingsKeys.all,
    queryFn: () => api.get(`${BASE}/settings`, { schema: globalSearchSettingsSchema }),
  })
}

export function useUpdateGlobalSearchSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateGlobalSearchSettings) =>
      api.put(`${BASE}/settings`, body, { schema: globalSearchSettingsSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: globalSearchSettingsKeys.all }),
  })
}

export function useTestRerank() {
  return useMutation({
    mutationFn: (body: TestRerankRequest) =>
      api.post(`${BASE}/settings/test`, body, { schema: testRerankResponseSchema }),
  })
}
