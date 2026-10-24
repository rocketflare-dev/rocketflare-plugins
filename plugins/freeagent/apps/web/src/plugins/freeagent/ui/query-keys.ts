/** Query-key families. Each root is an `entity.changed` entity the server nudges. */
import {
  FREEAGENT_BOOKS_ENTITY,
  FREEAGENT_CONNECTION_ENTITY,
} from '@rocketflare/shared/plugins/freeagent/index'

export const freeagentConnectionKeys = {
  all: [FREEAGENT_CONNECTION_ENTITY] as const,
  status: () => [FREEAGENT_CONNECTION_ENTITY, 'status'] as const,
}

export const freeagentBooksKeys = {
  all: [FREEAGENT_BOOKS_ENTITY] as const,
  transactions: (filters: Record<string, unknown>) =>
    [FREEAGENT_BOOKS_ENTITY, 'transactions', filters] as const,
  invoices: (filters: Record<string, unknown>) =>
    [FREEAGENT_BOOKS_ENTITY, 'invoices', filters] as const,
}

export const freeagentQueryKeys = {
  [FREEAGENT_CONNECTION_ENTITY]: freeagentConnectionKeys,
  [FREEAGENT_BOOKS_ENTITY]: freeagentBooksKeys,
} as const
