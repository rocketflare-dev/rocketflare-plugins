/**
 * The settings data layer: `api.*` with the shared schema on every request, and mutations that
 * invalidate the family rather than writing into the cache.
 */
import {
  type TestWebSearchRequest,
  testWebSearchResponseSchema,
  type UpdateWebSearchSettings,
  webSearchSettingsSchema,
} from '@rocketflare/shared/plugins/web-knowledge/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/plugins/api/ui'
import { webSearchSettingsKeys } from '../query-keys'

const BASE = '/api/web-knowledge/settings'

export function useWebSearchSettings() {
  return useQuery({
    queryKey: webSearchSettingsKeys.all,
    queryFn: () => api.get(BASE, { schema: webSearchSettingsSchema }),
  })
}

export function useUpdateWebSearchSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateWebSearchSettings) =>
      api.put(BASE, body, { schema: webSearchSettingsSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: webSearchSettingsKeys.all }),
  })
}

export function useTestWebSearch() {
  return useMutation({
    mutationFn: (body: TestWebSearchRequest) =>
      api.post(`${BASE}/test`, body, { schema: testWebSearchResponseSchema }),
  })
}
