/**
 * The guide's reads (`/api/guide/toc`, `/page`, `/search`) as query options, parsed with the shared
 * contracts. Pages never go stale within a tab; the TOC is refetched only to clear an admin's
 * "index is building" banner.
 */
import {
  GUIDE_API_ROOT,
  type GuidePageResponse,
  type GuideSearchResponse,
  type GuideTocResponse,
  guidePageResponseSchema,
  guideSearchResponseSchema,
  guideTocResponseSchema,
} from '@rocketflare/shared/plugins/guide/index'
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/plugins/api/ui'
import { guideKeys } from '../query-keys'

export function guideTocQuery() {
  return queryOptions<GuideTocResponse>({
    queryKey: guideKeys.toc,
    queryFn: () => api.get(`${GUIDE_API_ROOT}/toc`, { schema: guideTocResponseSchema }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: query => (query.state.data?.index === 'building' ? 30_000 : false),
  })
}

export function guidePageQuery(path: string) {
  return queryOptions<GuidePageResponse>({
    queryKey: guideKeys.page(path),
    queryFn: () =>
      api.get(`${GUIDE_API_ROOT}/page?path=${encodeURIComponent(path)}`, {
        schema: guidePageResponseSchema,
      }),
    enabled: Boolean(path),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function guideSearchQuery(q: string) {
  return queryOptions<GuideSearchResponse>({
    queryKey: guideKeys.search(q),
    queryFn: () =>
      api.get(`${GUIDE_API_ROOT}/search?q=${encodeURIComponent(q)}`, {
        schema: guideSearchResponseSchema,
      }),
    enabled: q.trim().length > 0,
    staleTime: 5 * 60_000,
  })
}
