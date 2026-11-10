/**
 * The provider contract bound to the kit's own types — what a provider's `search` receives on the
 * server. The shared module (`@rocketflare/shared/plugins/global-search`) carries the same shape
 * generically, because a shared module may name no server type. Re-exported from the server entry.
 *
 * A plugin registering a provider does NOT import either: it declares an object of this shape under
 * `ServerPlugin.extensions['global-search.providers']`, and the registry validates it at runtime.
 */
import type {
  SearchProviderCtxOf,
  SearchProviderOf,
} from '@rocketflare/shared/plugins/global-search/index'
import type { AccessScope, Database, PluginBindings, PluginConfig } from '@/plugins/api'

export type SearchProviderCtx = SearchProviderCtxOf<
  Database,
  PluginConfig,
  PluginBindings,
  AccessScope
>
export type SearchProvider = SearchProviderOf<SearchProviderCtx>
