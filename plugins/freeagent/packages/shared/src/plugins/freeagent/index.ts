/**
 * `freeagent` — an organisation's FreeAgent books (UK accounting), shared half (D31).
 *
 * One OAuth connection per organisation. The deployment registers ONE FreeAgent app
 * (`FREEAGENT_CLIENT_ID` / `FREEAGENT_CLIENT_SECRET`, sandbox or production by
 * `FREEAGENT_ENVIRONMENT`); an admin approves it for their company and the callback stores the
 * refresh token sealed. FreeAgent has no webhooks, so a half-hourly cron enqueues `freeagent.sync`
 * per connected organisation, which mirrors bank accounts, transactions, explanations, categories,
 * contacts, bills and invoices into `freeagent_*` tables (incremental by `updated_since`). Agents
 * read the mirror; the two write tools (explain a transaction, create a bill) need approval. After
 * each sync every `freeagent:sync-listeners` extension is called, which is how a receipts matcher
 * built on top rematches.
 *
 * Everything it keys carries the id: tables `freeagent_*`, jobs `freeagent.*`, `/api/freeagent`,
 * `/api/hooks/freeagent`, query-key roots `freeagent:…`, the CLI command `rocketflare freeagent`.
 *
 * Money is a decimal STRING everywhere (`"-12.50"`), as FreeAgent sends it and as Postgres
 * `numeric` returns it. Never a float.
 */
import { z } from 'zod'
import { paginatedResponse, paginationQuerySchema } from '../../pagination'
import type { SharedPlugin } from '../types'

export const FREEAGENT_ID = 'freeagent'

/** The one job: mirror one organisation's books, incrementally. */
export const FREEAGENT_SYNC_JOB = 'freeagent.sync'

/** CASL subject: the connection and everything mirrored through it. */
export const FREEAGENT_SUBJECT = 'FreeAgent'

/** Query-key roots, and the `entity.changed` entities the server nudges. */
export const FREEAGENT_CONNECTION_ENTITY = 'freeagent:connection'
export const FREEAGENT_BOOKS_ENTITY = 'freeagent:books'

/**
 * The extension key a listener plugin contributes under (D31 decision 6). In the shared half
 * because the shared half is a leaf — a listener reaching for the server entry at module scope
 * could find it half-evaluated through the server barrel.
 */
export const FREEAGENT_EXTENSION_KEYS = { syncListeners: `${FREEAGENT_ID}:sync-listeners` } as const

export function freeagentExtensions(contribution: {
  syncListeners: readonly unknown[]
}): Record<string, readonly unknown[]> {
  return { [FREEAGENT_EXTENSION_KEYS.syncListeners]: contribution.syncListeners }
}

/** The API version every request sends: multiple attachments per explanation (`attachments[]`). */
export const FREEAGENT_API_VERSION = '2026-09-01'

/** What FreeAgent accepts as an explanation attachment, and how big. */
export const FREEAGENT_ATTACHMENT_TYPES = [
  'image/png',
  'image/x-png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'application/x-pdf',
] as const
export const FREEAGENT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024

/** A decimal amount as a string: `-12.5`, `1000.00`. What FreeAgent sends and accepts. */
export const FREEAGENT_DECIMAL_RE = /^-?\d{1,13}(\.\d{1,4})?$/
export const decimalStringSchema = z
  .string()
  .trim()
  .regex(FREEAGENT_DECIMAL_RE, 'A decimal amount such as 12.50 or -12.50')
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD')

// ---- Config -------------------------------------------------------------------------------------

export const FREEAGENT_ENVIRONMENTS = ['sandbox', 'production'] as const
export const freeagentEnvironmentSchema = z.enum(FREEAGENT_ENVIRONMENTS)
export type FreeAgentEnvironment = z.infer<typeof freeagentEnvironmentSchema>

const optional = z
  .string()
  .trim()
  .optional()
  .transform(value => (value ? value : undefined))

/**
 * The operator's FreeAgent app. Both credentials unset → connecting is off and Settings says so.
 * All three are declared as secrets in the manifest so the plugin needs no toml edit;
 * `FREEAGENT_ENVIRONMENT` is not sensitive and a host may put it under `[vars]` in BOTH tomls
 * instead. Unset, it is `sandbox` — a forgotten var touches nobody's real books.
 */
export const freeagentConfigShape = {
  FREEAGENT_CLIENT_ID: optional,
  FREEAGENT_CLIENT_SECRET: optional,
  FREEAGENT_ENVIRONMENT: z
    .string()
    .trim()
    .optional()
    .transform(value => (value ? value : 'sandbox'))
    .pipe(freeagentEnvironmentSchema),
} satisfies z.ZodRawShape

export const freeagentConfigSchema = z.object(freeagentConfigShape)
export type FreeAgentConfig = z.infer<typeof freeagentConfigSchema>

// ---- Connection ---------------------------------------------------------------------------------

/** `connected` works; `needs_reconnect` means FreeAgent refused the refresh token (`invalid_grant`). */
export const FREEAGENT_CONNECTION_STATUSES = ['connected', 'needs_reconnect'] as const
export const freeagentConnectionStatusSchema = z.enum(FREEAGENT_CONNECTION_STATUSES)
export type FreeAgentConnectionStatus = z.infer<typeof freeagentConnectionStatusSchema>

export const freeagentStatusSchema = z.object({
  /** The deployment has an app (client id and secret). */
  configured: z.boolean(),
  /** What new connections use. */
  environment: freeagentEnvironmentSchema,
  connected: z.boolean(),
  status: freeagentConnectionStatusSchema.nullable(),
  /** The environment the stored connection was made in — may differ after a config change. */
  connectionEnvironment: freeagentEnvironmentSchema.nullable(),
  companyName: z.string().nullable(),
  companyCurrency: z.string().nullable(),
  connectedAt: z.coerce.date().nullable(),
  lastSyncAt: z.coerce.date().nullable(),
  lastSyncStartedAt: z.coerce.date().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.coerce.date().nullable(),
  counts: z.object({
    bankAccounts: z.number().int(),
    transactions: z.number().int(),
    unexplained: z.number().int(),
    invoices: z.number().int(),
    bills: z.number().int(),
  }),
})
export type FreeAgentStatus = z.infer<typeof freeagentStatusSchema>

/** `POST /api/freeagent/connect` — where to send the admin's browser. */
export const freeagentConnectResponseSchema = z.object({ approveUrl: z.string().url() })
export type FreeAgentConnectResponse = z.infer<typeof freeagentConnectResponseSchema>

/** `POST /api/freeagent/sync` — the envelope of the queued sync. */
export const freeagentSyncResponseSchema = z.object({
  jobId: z.string().uuid(),
  type: z.literal(FREEAGENT_SYNC_JOB),
})
export type FreeAgentSyncResponse = z.infer<typeof freeagentSyncResponseSchema>

// ---- The mirror, as the UI and CLI read it -------------------------------------------------------

export const freeagentTransactionSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  bankAccountUrl: z.string(),
  bankAccountName: z.string().nullable(),
  datedOn: z.string(),
  amount: z.string(),
  unexplainedAmount: z.string(),
  isUnexplained: z.boolean(),
  description: z.string().nullable(),
})
export type FreeAgentTransaction = z.infer<typeof freeagentTransactionSchema>

export const freeagentTransactionListQuerySchema = paginationQuerySchema.extend({
  unexplained: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => (v === undefined ? undefined : v === 'true')),
  bankAccountUrl: z.string().url().optional(),
})
export type FreeAgentTransactionListQuery = z.infer<typeof freeagentTransactionListQuerySchema>
export const freeagentTransactionListResponseSchema = paginatedResponse(freeagentTransactionSchema)
export type FreeAgentTransactionListResponse = z.infer<
  typeof freeagentTransactionListResponseSchema
>

export const freeagentInvoiceSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  reference: z.string().nullable(),
  contactName: z.string().nullable(),
  status: z.string().nullable(),
  datedOn: z.string().nullable(),
  dueOn: z.string().nullable(),
  currency: z.string().nullable(),
  totalValue: z.string().nullable(),
  paidValue: z.string().nullable(),
  dueValue: z.string().nullable(),
  overdue: z.boolean(),
})
export type FreeAgentInvoice = z.infer<typeof freeagentInvoiceSchema>

export const freeagentInvoiceListQuerySchema = paginationQuerySchema.extend({
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
})
export type FreeAgentInvoiceListQuery = z.infer<typeof freeagentInvoiceListQuerySchema>
export const freeagentInvoiceListResponseSchema = paginatedResponse(freeagentInvoiceSchema)
export type FreeAgentInvoiceListResponse = z.infer<typeof freeagentInvoiceListResponseSchema>

// ---- Writes (the exported service API and the two approval-gated tools) --------------------------

export const freeagentExplainInputSchema = z.object({
  bankTransactionUrl: z.string().url(),
  categoryUrl: z.string().url(),
  /** Signed like the transaction: money out is negative. */
  grossValue: decimalStringSchema,
  datedOn: dateSchema,
  description: z.string().trim().min(1).max(500),
  /** A percentage (`20`), or omitted to let FreeAgent apply the category's automatic rate. */
  salesTaxRate: decimalStringSchema.optional(),
  receiptReference: z.string().trim().max(100).optional(),
})
export type FreeAgentExplainInput = z.infer<typeof freeagentExplainInputSchema>

export const freeagentBillItemSchema = z.object({
  categoryUrl: z.string().url(),
  description: z.string().trim().min(1).max(500),
  /** Including tax. */
  totalValue: decimalStringSchema,
  salesTaxRate: decimalStringSchema.optional(),
})
export const freeagentCreateBillInputSchema = z.object({
  contactUrl: z.string().url(),
  reference: z.string().trim().min(1).max(100),
  datedOn: dateSchema,
  dueOn: dateSchema,
  items: z.array(freeagentBillItemSchema).min(1).max(40),
})
export type FreeAgentCreateBillInput = z.infer<typeof freeagentCreateBillInputSchema>

// ---- Jobs ---------------------------------------------------------------------------------------

export const freeagentSyncPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  /** Who asked, for the audit trail; absent for the cron. */
  requestedBy: z.string().uuid().optional(),
})
export type FreeAgentSyncPayload = z.infer<typeof freeagentSyncPayloadSchema>

// ---- The plugin ---------------------------------------------------------------------------------

export const freeagentShared = {
  id: FREEAGENT_ID,
  label: 'FreeAgent',
  version: '3.5.1',
  subjects: [FREEAGENT_SUBJECT],
  jobs: [z.object({ type: z.literal(FREEAGENT_SYNC_JOB), payload: freeagentSyncPayloadSchema })],
  config: freeagentConfigShape,
} as const satisfies SharedPlugin
