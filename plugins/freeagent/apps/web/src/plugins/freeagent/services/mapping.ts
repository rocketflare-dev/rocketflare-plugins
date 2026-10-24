/**
 * FreeAgent JSON → mirror rows. Pure, so the whole translation is table-tested without a database
 * (`tests/config/mapping.test.ts`).
 *
 * Each mapper parses with a PERMISSIVE zod schema (`passthrough`, everything but the URL optional)
 * and fails loudly on the one thing it cannot do without: a resource with no `url` is unusable,
 * because the URL is the key. Field names are FreeAgent's, checked against dev.freeagent.com.
 *
 * Money stays a decimal STRING from end to end. FreeAgent sends `"-730.0"`; Postgres `numeric`
 * takes it as is; nothing here ever goes through `Number`.
 */
import { z } from 'zod'
import { FreeAgentError } from './errors'

/** FreeAgent sends decimals as strings, but be lenient about a bare number. */
const decimal = z
  .union([z.string(), z.number()])
  .transform(v => String(v).trim())
  .refine(v => /^-?\d+(\.\d+)?$/.test(v), 'not a decimal')
const optionalDecimal = decimal.nullish().transform(v => v ?? null)
const optionalString = z
  .string()
  .nullish()
  .transform(v => (v === undefined || v === null || v === '' ? null : v))
const optionalDate = z
  .string()
  .nullish()
  .transform(v => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null))
const optionalTimestamp = z
  .string()
  .nullish()
  .transform(v => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  })
const optionalBoolean = z
  .union([z.boolean(), z.string()])
  .nullish()
  .transform(v => (v === undefined || v === null ? null : v === true || v === 'true'))

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new FreeAgentError(
      'bad_response',
      `Unreadable FreeAgent ${what}: ${issue?.path.join('.') || '<root>'} ${issue?.message ?? ''}`.trim()
    )
  }
  return result.data
}

/** `"0.0"`, `"-0"`, `"0"` → false; anything else that is a decimal → true. */
export function isNonZeroDecimal(value: string | null | undefined): boolean {
  if (!value) return false
  return !/^-?0*(\.0*)?$/.test(value.trim())
}

// ---- Bank accounts ------------------------------------------------------------------------------

const bankAccountSchema = z
  .object({
    url: z.string().url(),
    name: z.string().nullish(),
    type: optionalString,
    currency: optionalString,
    current_balance: optionalDecimal,
    bank_name: optionalString,
    is_primary: optionalBoolean,
    status: optionalString,
    updated_at: optionalTimestamp,
  })
  .passthrough()

export function mapBankAccount(raw: unknown) {
  const a = parse(bankAccountSchema, raw, 'bank account')
  return {
    url: a.url,
    name: a.name || a.bank_name || 'Bank account',
    type: a.type,
    currency: a.currency,
    currentBalance: a.current_balance,
    bankName: a.bank_name,
    isPrimary: a.is_primary ?? false,
    status: a.status,
    faUpdatedAt: a.updated_at,
  }
}

// ---- Explanations -------------------------------------------------------------------------------

const explanationSchema = z
  .object({
    url: z.string().url(),
    bank_transaction: optionalString,
    bank_account: optionalString,
    category: optionalString,
    type: optionalString,
    entry_type: optionalString,
    dated_on: optionalDate,
    description: optionalString,
    gross_value: optionalDecimal,
    sales_tax_rate: optionalDecimal,
    sales_tax_value: optionalDecimal,
    is_deletable: optionalBoolean,
    /** `X-Api-Version: 2026-09-01` — an array of `{ url }`. */
    attachments: z.array(z.unknown()).nullish(),
    /** The pre-2026-09-01 single attachment, for a response that still carries it. */
    attachment: z.unknown().nullish(),
  })
  .passthrough()

export function mapExplanation(raw: unknown) {
  const e = parse(explanationSchema, raw, 'bank transaction explanation')
  return {
    url: e.url,
    bankTransactionUrl: e.bank_transaction,
    bankAccountUrl: e.bank_account,
    categoryUrl: e.category,
    entryType: e.type ?? e.entry_type,
    datedOn: e.dated_on,
    description: e.description,
    grossValue: e.gross_value,
    salesTaxRate: e.sales_tax_rate,
    salesTaxValue: e.sales_tax_value,
    attachmentCount: Array.isArray(e.attachments) ? e.attachments.length : e.attachment ? 1 : 0,
    isDeletable: e.is_deletable,
  }
}

/**
 * The SUBSET a bank transaction embeds in `bank_transaction_explanations` (no category, no tax):
 * written on conflict without touching the columns only the explanations endpoint knows.
 */
export function mapEmbeddedExplanation(raw: unknown, transactionUrl: string) {
  const e = mapExplanation(raw)
  return {
    url: e.url,
    bankTransactionUrl: e.bankTransactionUrl ?? transactionUrl,
    bankAccountUrl: e.bankAccountUrl,
    entryType: e.entryType,
    datedOn: e.datedOn,
    description: e.description,
    grossValue: e.grossValue,
    isDeletable: e.isDeletable,
  }
}

// ---- Bank transactions --------------------------------------------------------------------------

const bankTransactionSchema = z
  .object({
    url: z.string().url(),
    bank_account: z.string(),
    dated_on: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    amount: decimal,
    description: optionalString,
    full_description: optionalString,
    unexplained_amount: optionalDecimal,
    is_manual: optionalBoolean,
    created_at: optionalTimestamp,
    updated_at: optionalTimestamp,
    bank_transaction_explanations: z.array(z.unknown()).nullish(),
  })
  .passthrough()

export function mapBankTransaction(raw: unknown) {
  const t = parse(bankTransactionSchema, raw, 'bank transaction')
  const unexplained = t.unexplained_amount ?? '0'
  return {
    row: {
      url: t.url,
      bankAccountUrl: t.bank_account,
      datedOn: t.dated_on.slice(0, 10),
      amount: t.amount,
      description: t.description,
      fullDescription: t.full_description,
      unexplainedAmount: unexplained,
      isUnexplained: isNonZeroDecimal(unexplained),
      isManual: t.is_manual ?? false,
      faCreatedAt: t.created_at,
      faUpdatedAt: t.updated_at,
    },
    /** Null when the answer did not include the list at all — then nothing may be reconciled. */
    explanations:
      t.bank_transaction_explanations === undefined || t.bank_transaction_explanations === null
        ? null
        : t.bank_transaction_explanations.map(e => mapEmbeddedExplanation(e, t.url)),
  }
}

// ---- Categories ---------------------------------------------------------------------------------

export const CATEGORY_KINDS = {
  admin_expenses_categories: 'admin_expenses',
  cost_of_sales_categories: 'cost_of_sales',
  income_categories: 'income',
  general_categories: 'general',
} as const

const categorySchema = z
  .object({
    url: z.string().url(),
    description: z.string().nullish(),
    nominal_code: optionalString,
    group_description: optionalString,
    allowable_for_tax: optionalBoolean,
    tax_reporting_name: optionalString,
    auto_sales_tax_rate: z
      .union([z.string(), z.number()])
      .nullish()
      .transform(v => (v === undefined || v === null ? null : String(v))),
  })
  .passthrough()

/** `GET /v2/categories` answers four lists under four keys; flatten them, keeping the key. */
export function mapCategories(raw: unknown) {
  if (!raw || typeof raw !== 'object') {
    throw new FreeAgentError('bad_response', 'Unreadable FreeAgent categories answer')
  }
  const out = []
  for (const [key, kind] of Object.entries(CATEGORY_KINDS)) {
    const list = (raw as Record<string, unknown>)[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const c = parse(categorySchema, item, 'category')
      out.push({
        url: c.url,
        description: c.description || c.nominal_code || c.url,
        nominalCode: c.nominal_code,
        kind,
        groupDescription: c.group_description,
        allowableForTax: c.allowable_for_tax,
        taxReportingName: c.tax_reporting_name,
        autoSalesTaxRate: c.auto_sales_tax_rate,
      })
    }
  }
  return out
}

// ---- Contacts -----------------------------------------------------------------------------------

const contactSchema = z
  .object({
    url: z.string().url(),
    organisation_name: optionalString,
    first_name: optionalString,
    last_name: optionalString,
    email: optionalString,
    status: optionalString,
    updated_at: optionalTimestamp,
  })
  .passthrough()

export function mapContact(raw: unknown) {
  const c = parse(contactSchema, raw, 'contact')
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ')
  return {
    url: c.url,
    displayName: c.organisation_name || person || c.email || c.url,
    organisationName: c.organisation_name,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    status: c.status,
    faUpdatedAt: c.updated_at,
  }
}

// ---- Bills and invoices -------------------------------------------------------------------------

const documentSchema = z
  .object({
    url: z.string().url(),
    contact: optionalString,
    reference: optionalString,
    dated_on: optionalDate,
    due_on: optionalDate,
    paid_on: optionalDate,
    status: optionalString,
    currency: optionalString,
    total_value: optionalDecimal,
    net_value: optionalDecimal,
    sales_tax_value: optionalDecimal,
    paid_value: optionalDecimal,
    due_value: optionalDecimal,
    updated_at: optionalTimestamp,
  })
  .passthrough()

export function mapBill(raw: unknown) {
  const b = parse(documentSchema, raw, 'bill')
  return {
    url: b.url,
    contactUrl: b.contact,
    reference: b.reference,
    datedOn: b.dated_on,
    dueOn: b.due_on,
    paidOn: b.paid_on,
    status: b.status,
    currency: b.currency,
    totalValue: b.total_value,
    netValue: b.net_value,
    salesTaxValue: b.sales_tax_value,
    paidValue: b.paid_value,
    dueValue: b.due_value,
    faUpdatedAt: b.updated_at,
  }
}

export function mapInvoice(raw: unknown) {
  const i = parse(documentSchema, raw, 'invoice')
  return {
    url: i.url,
    contactUrl: i.contact,
    reference: i.reference,
    datedOn: i.dated_on,
    dueOn: i.due_on,
    paidOn: i.paid_on,
    status: i.status,
    currency: i.currency,
    netValue: i.net_value,
    totalValue: i.total_value,
    paidValue: i.paid_value,
    dueValue: i.due_value,
    faUpdatedAt: i.updated_at,
  }
}

// ---- Company ------------------------------------------------------------------------------------

const companySchema = z.object({
  company: z
    .object({
      url: optionalString,
      name: z.string().nullish(),
      currency: optionalString,
    })
    .passthrough(),
})

export function mapCompany(raw: unknown) {
  const { company } = parse(companySchema, raw, 'company')
  return {
    companyUrl: company.url,
    companyName: company.name ?? null,
    companyCurrency: company.currency,
  }
}

// ---- Overdue ------------------------------------------------------------------------------------

/** Statuses after which nothing is owed, or before which nothing is due yet. */
export const SETTLED_STATUSES = [
  'Draft',
  'Scheduled To Email',
  'Paid',
  'Overpaid',
  'Refunded',
  'Written-off',
  'Zero Value',
  'Cancelled',
] as const

/** An invoice or bill is overdue when something is still owed and its due date has passed. */
export function isOverdue(
  doc: { status: string | null; dueOn: string | null; dueValue: string | null },
  today: string
): boolean {
  if (doc.status === 'Overdue') return true
  if (!doc.dueOn || !isNonZeroDecimal(doc.dueValue)) return false
  if (doc.status && (SETTLED_STATUSES as readonly string[]).includes(doc.status)) return false
  return doc.dueOn < today
}
