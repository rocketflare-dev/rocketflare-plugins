/**
 * The provider registry: everything installed plugins contributed under
 * `extensions['global-search.providers']`, validated.
 *
 * The kit's rule for a cross-plugin registry is that the OWNING plugin narrows with zod and fails
 * loudly, so a registration that does not parse is an error naming who contributed under the key
 * and what is wrong — never a provider that silently does not appear. Three rules beyond the
 * schema:
 *
 * - a provider id is `<plugin id>:<list>`, and the plugin half must be one of the plugins that
 *   contributed (a plugin cannot register a list in another's name);
 * - provider ids are unique;
 * - a kind belongs to ONE provider, so its label, badge and tone have one owner.
 *
 * Read at CALL time (`installedProviders()`), never at module scope: `extensions()` reads the
 * server barrel, which imports this plugin (`plugins/api/peers.ts` explains the cycle).
 */
import {
  SEARCH_PROVIDER_ID_RE,
  SEARCH_PROVIDERS_EXTENSION,
  searchProviderRegistrationSchema,
} from '@rocketflare/shared/plugins/global-search/index'
import { extensionSources, extensions } from '@/plugins/api/peers'
import type { SearchProvider } from '../types'

export class InvalidSearchProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSearchProviderError'
  }
}

function describe(value: unknown): string {
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return `'${value.id}'`
  }
  return 'an entry with no id'
}

/**
 * Validate every contribution, in order. `sources` are the plugin ids that contributed under the
 * key (`extensionSources`). Throws `InvalidSearchProviderError` on the first problem. Pure.
 */
export function buildRegistry(
  contributions: readonly unknown[],
  sources: readonly string[]
): SearchProvider[] {
  const from = sources.length > 0 ? sources.join(', ') : 'no plugin'
  const fail = (what: string): never => {
    throw new InvalidSearchProviderError(
      `global-search: refused a registration under '${SEARCH_PROVIDERS_EXTENSION}' (contributed by ${from}): ${what}`
    )
  }
  const providers: SearchProvider[] = []
  const ids = new Set<string>()
  const kindOwner = new Map<string, string>()
  contributions.forEach((entry, index) => {
    const parsed = searchProviderRegistrationSchema.safeParse(entry)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(i => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
        .join('; ')
      fail(`entry ${index} (${describe(entry)}) — ${issues}`)
      return
    }
    const provider = entry as SearchProvider
    const pluginId = SEARCH_PROVIDER_ID_RE.exec(provider.id)?.[1] ?? ''
    if (!sources.includes(pluginId)) {
      fail(
        `provider '${provider.id}' is namespaced '${pluginId}', which is not a plugin that registered providers`
      )
    }
    if (ids.has(provider.id)) fail(`provider '${provider.id}' is registered twice`)
    ids.add(provider.id)
    for (const { kind } of provider.kinds) {
      const owner = kindOwner.get(kind)
      if (owner) fail(`kind '${kind}' is declared by both '${owner}' and '${provider.id}'`)
      kindOwner.set(kind, provider.id)
    }
    providers.push(provider)
  })
  return providers
}

/** Every installed provider, validated. Throws loudly on a bad registration. */
export function installedProviders(): SearchProvider[] {
  return buildRegistry(
    extensions(SEARCH_PROVIDERS_EXTENSION),
    extensionSources(SEARCH_PROVIDERS_EXTENSION)
  )
}
