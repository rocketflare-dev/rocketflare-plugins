/**
 * The plugin's query families. Each root is the same string the server nudges, so a colleague's
 * connect, a finished sync pass or a disconnect refreshes every open tab without a poll.
 */
import {
  CONNECTORS_EVENTS_ENTITY,
  CONNECTORS_INSTALLATIONS_ENTITY,
} from '@rocketflare/shared/plugins/connectors/index'

export const connectorsInstallationKeys = {
  all: [CONNECTORS_INSTALLATIONS_ENTITY] as const,
  providers: () => [CONNECTORS_INSTALLATIONS_ENTITY, 'providers'] as const,
  list: () => [CONNECTORS_INSTALLATIONS_ENTITY, 'list'] as const,
}

export const connectorsEventKeys = {
  all: [CONNECTORS_EVENTS_ENTITY] as const,
  window: (from: string, to: string) => [CONNECTORS_EVENTS_ENTITY, from, to] as const,
}

export const connectorsQueryKeys = {
  [CONNECTORS_INSTALLATIONS_ENTITY]: connectorsInstallationKeys,
  [CONNECTORS_EVENTS_ENTITY]: connectorsEventKeys,
} as const
