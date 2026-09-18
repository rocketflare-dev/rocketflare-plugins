/**
 * Provider id → adapter. The `Record` over `WebSearchProvider` is the exhaustiveness check: adding
 * a provider to the shared list without an adapter here is a compile error.
 */
import type { WebSearchProvider } from '@rocketflare/shared/plugins/web-knowledge/index'
import { brave } from './brave'
import { exa } from './exa'
import { firecrawl } from './firecrawl'
import { serper } from './serper'
import { tavily } from './tavily'
import type { SearchAdapter } from './types'

export const SEARCH_ADAPTERS: Record<WebSearchProvider, SearchAdapter> = {
  tavily,
  brave,
  exa,
  serper,
  firecrawl,
}

export * from './types'
