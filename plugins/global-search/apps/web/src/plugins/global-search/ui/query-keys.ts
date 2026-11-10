/**
 * The plugin's query families. Every root starts with `global-search:`; the settings root is the
 * same string the server nudges on a save (`GLOBAL_SEARCH_SETTINGS_ENTITY`), so an admin's save
 * refreshes every open settings tab for free.
 */
import {
  GLOBAL_SEARCH_PROVIDERS_ROOT,
  GLOBAL_SEARCH_RESULTS_ROOT,
  GLOBAL_SEARCH_SETTINGS_ENTITY,
} from '@rocketflare/shared/plugins/global-search/index'

/** What the UI asks `GET /api/global-search` — `kinds` as a list; the hook joins it. */
export interface GlobalSearchParams {
  q: string
  kinds?: string[]
  limit?: number
}

export const globalSearchKeys = {
  all: [GLOBAL_SEARCH_RESULTS_ROOT] as const,
  query: (params: GlobalSearchParams) => [GLOBAL_SEARCH_RESULTS_ROOT, params] as const,
}

export const searchProvidersKeys = {
  all: [GLOBAL_SEARCH_PROVIDERS_ROOT] as const,
}

export const globalSearchSettingsKeys = {
  all: [GLOBAL_SEARCH_SETTINGS_ENTITY] as const,
}

export const globalSearchQueryKeys = {
  [GLOBAL_SEARCH_RESULTS_ROOT]: globalSearchKeys,
  [GLOBAL_SEARCH_PROVIDERS_ROOT]: searchProvidersKeys,
  [GLOBAL_SEARCH_SETTINGS_ENTITY]: globalSearchSettingsKeys,
} as const
