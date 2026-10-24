/**
 * Writes to FreeAgent, and the mirror read other plugins build on — the exported service API.
 *
 * Every write updates the mirror row it touched in the same call, so a matcher that explains a
 * transaction sees it explained at once rather than after the next half-hourly sync: the new
 * explanation is upserted, and the transaction is re-read from FreeAgent for its new
 * `unexplained_amount` (FreeAgent computes it; we never guess it).
 *
 * Inputs are parsed with the shared zod schemas before anything is sent, and every resource URL a
 * caller passes is checked to be on the connection's own API host (`FreeAgentClient.resolve`) — a
 * URL is how FreeAgent names things, and the bearer token must never follow one anywhere else.
 */
import {
  FREEAGENT_ATTACHMENT_MAX_BYTES,
  FREEAGENT_ATTACHMENT_TYPES,
  type FreeAgentCreateBillInput,
  type FreeAgentExplainInput,
  freeagentCreateBillInputSchema,
  freeagentExplainInputSchema,
} from '@rocketflare/shared/plugins/freeagent/index'
import { and, asc, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import {
  type FreeAgentBankTransactionRow,
  freeagentBankAccounts,
  freeagentBankTransactions,
  freeagentExplanations,
} from '../db/schema'
import type { FreeAgentClient } from './client'
import { type FreeAgentCtx, freeagentClientFor } from './connection'
import { type FreeAgentDeps, freeagentHttp } from './env'
import { FreeAgentError } from './errors'
import { mapBankTransaction, mapBill, mapExplanation } from './mapping'
import { deleteByUrl, MIRROR_TABLES, pruneExplanations, upsertMirror } from './mirror'

/** Parse with a shared schema, turning a zod failure into `FreeAgentError('validation')`. */
function input<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new FreeAgentError(
      'validation',
      `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`
    )
  }
  return parsed.data
}

function requireOwned(client: FreeAgentClient, url: string, what: string): void {
  if (!client.owns(url)) {
    throw new FreeAgentError('validation', `${what} is not a URL on this FreeAgent connection`)
  }
}

/** Re-read one transaction and write it (and its explanation list) to the mirror. */
async function refreshTransaction(
  ctx: FreeAgentCtx,
  client: FreeAgentClient,
  tenantId: string,
  bankTransactionUrl: string
): Promise<void> {
  const body = await client.get<{ bank_transaction?: unknown }>(bankTransactionUrl)
  const mapped = mapBankTransaction(body.bank_transaction)
  await upsertMirror(ctx.db, MIRROR_TABLES.bankTransactions, tenantId, [mapped.row])
  if (mapped.explanations) {
    await upsertMirror(ctx.db, MIRROR_TABLES.explanations, tenantId, mapped.explanations)
    await pruneExplanations(
      ctx.db,
      tenantId,
      mapped.row.url,
      mapped.explanations.map(e => e.url)
    )
  }
}

export type ExplanationView = ReturnType<typeof mapExplanation>

/**
 * Explain (part of) a bank transaction: `POST /v2/bank_transaction_explanations`. `grossValue` is
 * signed like the transaction (money out is negative). Answers the explanation as mirrored.
 */
export async function explainTransaction(
  ctx: FreeAgentCtx,
  tenantId: string,
  raw: FreeAgentExplainInput,
  deps: FreeAgentDeps = freeagentHttp
): Promise<ExplanationView> {
  const body = input(freeagentExplainInputSchema, raw)
  const client = await freeagentClientFor(ctx, tenantId, deps)
  requireOwned(client, body.bankTransactionUrl, 'bankTransactionUrl')
  requireOwned(client, body.categoryUrl, 'categoryUrl')
  const created = await client.post<{ bank_transaction_explanation?: unknown }>(
    '/v2/bank_transaction_explanations',
    {
      bank_transaction_explanation: {
        bank_transaction: body.bankTransactionUrl,
        category: body.categoryUrl,
        gross_value: body.grossValue,
        dated_on: body.datedOn,
        description: body.description,
        ...(body.salesTaxRate !== undefined && { sales_tax_rate: body.salesTaxRate }),
        ...(body.receiptReference !== undefined && { receipt_reference: body.receiptReference }),
      },
    }
  )
  const explanation = mapExplanation(created.bank_transaction_explanation)
  await upsertMirror(ctx.db, MIRROR_TABLES.explanations, tenantId, [
    {
      ...explanation,
      bankTransactionUrl: explanation.bankTransactionUrl ?? body.bankTransactionUrl,
    },
  ])
  await refreshTransaction(ctx, client, tenantId, body.bankTransactionUrl)
  return explanation
}

export interface AttachmentInput {
  bytes: ArrayBuffer | Uint8Array
  filename: string
  contentType: string
  description?: string
}

/** FreeAgent's spelling of a PDF is `application/x-pdf`; accept the standard one and translate. */
export function freeagentContentType(contentType: string): string | null {
  const type = contentType.toLowerCase().split(';')[0]?.trim() ?? ''
  const normalised = type === 'application/pdf' ? 'application/x-pdf' : type
  return (FREEAGENT_ATTACHMENT_TYPES as readonly string[]).includes(normalised) ? normalised : null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Attach a file to an explanation: `POST {explanation}/attachments` (API version 2026-09-01,
 * up to 50 per explanation). PNG, JPEG, GIF or PDF, at most 5 MB — refused here, before any bytes
 * leave. Answers the explanation's attachment count after the upload, which the mirror now holds.
 */
export async function attachToExplanation(
  ctx: FreeAgentCtx,
  tenantId: string,
  explanationUrl: string,
  file: AttachmentInput,
  deps: FreeAgentDeps = freeagentHttp
): Promise<{ attachmentCount: number; attachmentUrls: string[] }> {
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes)
  const contentType = freeagentContentType(file.contentType)
  if (!contentType) {
    throw new FreeAgentError(
      'validation',
      `FreeAgent accepts PNG, JPEG, GIF or PDF attachments, not ${file.contentType}`
    )
  }
  if (bytes.byteLength === 0 || bytes.byteLength > FREEAGENT_ATTACHMENT_MAX_BYTES) {
    throw new FreeAgentError('validation', 'An attachment must be between 1 byte and 5 MB')
  }
  const client = await freeagentClientFor(ctx, tenantId, deps)
  requireOwned(client, explanationUrl, 'explanationUrl')
  const filename = file.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'attachment'
  const answer = await client.post<{ attachments?: Array<{ url?: string }> }>(
    `${explanationUrl.replace(/\/+$/, '')}/attachments`,
    {
      attachments: [
        {
          data: toBase64(bytes),
          file_name: filename,
          content_type: contentType,
          description: file.description ?? filename,
        },
      ],
    }
  )
  const attachments = Array.isArray(answer.attachments) ? answer.attachments : []
  await ctx.db
    .update(freeagentExplanations)
    .set({ attachmentCount: attachments.length })
    .where(
      and(
        eq(freeagentExplanations.tenantId, tenantId),
        eq(freeagentExplanations.url, explanationUrl)
      )
    )
  return {
    attachmentCount: attachments.length,
    attachmentUrls: attachments.map(a => a.url).filter((u): u is string => typeof u === 'string'),
  }
}

/** Delete an explanation, and re-read its transaction (which is now unexplained again). */
export async function deleteExplanation(
  ctx: FreeAgentCtx,
  tenantId: string,
  explanationUrl: string,
  deps: FreeAgentDeps = freeagentHttp
): Promise<void> {
  const client = await freeagentClientFor(ctx, tenantId, deps)
  requireOwned(client, explanationUrl, 'explanationUrl')
  const [mirrored] = await ctx.db
    .select({ bankTransactionUrl: freeagentExplanations.bankTransactionUrl })
    .from(freeagentExplanations)
    .where(
      and(
        eq(freeagentExplanations.tenantId, tenantId),
        eq(freeagentExplanations.url, explanationUrl)
      )
    )
    .limit(1)
  await client.delete(explanationUrl)
  await deleteByUrl(ctx.db, MIRROR_TABLES.explanations, tenantId, [explanationUrl])
  if (mirrored?.bankTransactionUrl) {
    await refreshTransaction(ctx, client, tenantId, mirrored.bankTransactionUrl)
  }
}

export type BillView = ReturnType<typeof mapBill>

/** Create a bill: `POST /v2/bills`. Answers the bill as mirrored. */
export async function createBill(
  ctx: FreeAgentCtx,
  tenantId: string,
  raw: FreeAgentCreateBillInput,
  deps: FreeAgentDeps = freeagentHttp
): Promise<BillView> {
  const body = input(freeagentCreateBillInputSchema, raw)
  const client = await freeagentClientFor(ctx, tenantId, deps)
  requireOwned(client, body.contactUrl, 'contactUrl')
  for (const item of body.items) requireOwned(client, item.categoryUrl, 'categoryUrl')
  const created = await client.post<{ bill?: unknown }>('/v2/bills', {
    bill: {
      contact: body.contactUrl,
      reference: body.reference,
      dated_on: body.datedOn,
      due_on: body.dueOn,
      bill_items: body.items.map(item => ({
        category: item.categoryUrl,
        description: item.description,
        total_value: item.totalValue,
        ...(item.salesTaxRate !== undefined && { sales_tax_rate: item.salesTaxRate }),
      })),
    },
  })
  const bill = mapBill(created.bill)
  await upsertMirror(ctx.db, MIRROR_TABLES.bills, tenantId, [bill])
  return bill
}

export interface UnexplainedTransaction extends FreeAgentBankTransactionRow {
  bankAccountName: string | null
}

/**
 * Unexplained bank transactions from the MIRROR (no FreeAgent call) — what a matcher iterates.
 * Newest first; narrow by account and date range.
 */
export async function listUnexplainedTransactions(
  ctx: Pick<FreeAgentCtx, 'db'>,
  tenantId: string,
  opts: {
    bankAccountUrl?: string
    from?: string
    to?: string
    limit?: number
    oldestFirst?: boolean
  } = {}
): Promise<UnexplainedTransaction[]> {
  const filters: SQL[] = [
    eq(freeagentBankTransactions.tenantId, tenantId),
    eq(freeagentBankTransactions.isUnexplained, true),
  ]
  if (opts.bankAccountUrl)
    filters.push(eq(freeagentBankTransactions.bankAccountUrl, opts.bankAccountUrl))
  if (opts.from) filters.push(gte(freeagentBankTransactions.datedOn, opts.from))
  if (opts.to) filters.push(lte(freeagentBankTransactions.datedOn, opts.to))
  const rows = await ctx.db
    .select({ tx: freeagentBankTransactions, bankAccountName: freeagentBankAccounts.name })
    .from(freeagentBankTransactions)
    .leftJoin(
      freeagentBankAccounts,
      and(
        eq(freeagentBankAccounts.tenantId, freeagentBankTransactions.tenantId),
        eq(freeagentBankAccounts.url, freeagentBankTransactions.bankAccountUrl)
      )
    )
    .where(and(...filters))
    .orderBy(
      opts.oldestFirst
        ? asc(freeagentBankTransactions.datedOn)
        : desc(freeagentBankTransactions.datedOn),
      asc(freeagentBankTransactions.url)
    )
    .limit(Math.min(Math.max(opts.limit ?? 500, 1), 5000))
  return rows.map(r => ({ ...r.tx, bankAccountName: r.bankAccountName }))
}
