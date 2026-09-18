/**
 * The plugin's query family. The root is the same string the server nudges on a settings write
 * (`WEB_SEARCH_SETTINGS_ENTITY`), so an admin's save refreshes every open settings tab for free.
 */
import { WEB_SEARCH_SETTINGS_ENTITY } from '@rocketflare/shared/plugins/web-knowledge/index'

export const webSearchSettingsKeys = {
  all: [WEB_SEARCH_SETTINGS_ENTITY] as const,
}

export const webKnowledgeQueryKeys = {
  [WEB_SEARCH_SETTINGS_ENTITY]: webSearchSettingsKeys,
} as const
