/** Query-key families. Each root is an `entity.changed` entity the server nudges. */
import {
  INBOX_MESSAGES_ENTITY,
  INBOX_SETTINGS_ENTITY,
} from '@rocketflare/shared/plugins/inbox/index'

export const inboxMessageKeys = {
  all: [INBOX_MESSAGES_ENTITY] as const,
  list: (filters: Record<string, unknown>) => [INBOX_MESSAGES_ENTITY, 'list', filters] as const,
  detail: (id: string) => [INBOX_MESSAGES_ENTITY, 'detail', id] as const,
}

export const inboxSettingsKeys = {
  all: [INBOX_SETTINGS_ENTITY] as const,
}

export const inboxQueryKeys = {
  [INBOX_MESSAGES_ENTITY]: inboxMessageKeys,
  [INBOX_SETTINGS_ENTITY]: inboxSettingsKeys,
} as const
