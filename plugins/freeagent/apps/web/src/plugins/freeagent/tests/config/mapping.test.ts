/** FreeAgent JSON → mirror rows, as tables (`services/mapping.ts`). Pure: no database, no network. */
import { describe, expect, it } from 'vitest'
import { FreeAgentError } from '../../services/errors'
import {
  isNonZeroDecimal,
  isOverdue,
  mapBankAccount,
  mapBankTransaction,
  mapBill,
  mapCategories,
  mapCompany,
  mapContact,
  mapExplanation,
  mapInvoice,
} from '../../services/mapping'

const API = 'https://api.sandbox.freeagent.com/v2'

describe('decimals', () => {
  it('treats every spelling of zero as zero, and keeps strings as strings', () => {
    for (const zero of ['0', '0.0', '-0.00', '0.', '00.000'])
      expect(isNonZeroDecimal(zero)).toBe(false)
    for (const v of ['-0.01', '12', '-730.0']) expect(isNonZeroDecimal(v)).toBe(true)
    expect(isNonZeroDecimal(null)).toBe(false)
  })
})

describe('bank transactions', () => {
  it('maps amounts as strings and derives is_unexplained', () => {
    const { row, explanations } = mapBankTransaction({
      url: `${API}/bank_transactions/1`,
      amount: '-730.0',
      bank_account: `${API}/bank_accounts/1`,
      dated_on: '2026-10-01',
      description: 'TRAINLINE',
      full_description: 'TRAINLINE.COM/LONDON',
      unexplained_amount: '-730.0',
      is_manual: false,
      updated_at: '2026-10-02T09:00:00.000Z',
      bank_transaction_explanations: [],
    })
    expect(row).toMatchObject({
      amount: '-730.0',
      unexplainedAmount: '-730.0',
      isUnexplained: true,
      datedOn: '2026-10-01',
      description: 'TRAINLINE',
    })
    expect(row.faUpdatedAt).toEqual(new Date('2026-10-02T09:00:00.000Z'))
    expect(explanations).toEqual([])
  })

  it('reads an explained transaction, its embedded explanations, and a missing list as null', () => {
    const explained = mapBankTransaction({
      url: `${API}/bank_transactions/2`,
      amount: 100,
      bank_account: `${API}/bank_accounts/1`,
      dated_on: '2026-10-01',
      unexplained_amount: '0.0',
      bank_transaction_explanations: [
        {
          url: `${API}/bank_transaction_explanations/9`,
          bank_account: `${API}/bank_accounts/1`,
          dated_on: '2026-10-01',
          entry_type: 'Business Entertaining',
          gross_value: '100.0',
          is_deletable: true,
        },
      ],
    })
    expect(explained.row).toMatchObject({ amount: '100', isUnexplained: false })
    expect(explained.explanations).toEqual([
      expect.objectContaining({
        url: `${API}/bank_transaction_explanations/9`,
        bankTransactionUrl: `${API}/bank_transactions/2`,
        entryType: 'Business Entertaining',
        grossValue: '100.0',
      }),
    ])
    expect(explained.explanations?.[0]).not.toHaveProperty('categoryUrl')
    const bare = mapBankTransaction({
      url: `${API}/bank_transactions/3`,
      amount: '1',
      bank_account: `${API}/bank_accounts/1`,
      dated_on: '2026-10-01',
    })
    expect(bare.explanations).toBeNull()
  })

  it('refuses a transaction it cannot key, with a typed error', () => {
    expect(() => mapBankTransaction({ amount: '1' })).toThrow(FreeAgentError)
    try {
      mapBankTransaction({ url: 'x' })
    } catch (err) {
      expect((err as FreeAgentError).code).toBe('bad_response')
    }
  })
})

describe('explanations', () => {
  it('counts the 2026-09-01 attachments array, and falls back to the single attachment', () => {
    const base = {
      url: `${API}/bank_transaction_explanations/1`,
      bank_transaction: `${API}/bank_transactions/1`,
      category: `${API}/categories/285`,
      gross_value: '-12.5',
      sales_tax_rate: '20.0',
      sales_tax_value: '-2.08',
      type: 'Payment',
      dated_on: '2026-10-01',
    }
    expect(
      mapExplanation({
        ...base,
        attachments: [{ url: `${API}/attachments/1` }, { url: `${API}/attachments/2` }],
      })
    ).toMatchObject({
      categoryUrl: `${API}/categories/285`,
      grossValue: '-12.5',
      salesTaxRate: '20.0',
      salesTaxValue: '-2.08',
      entryType: 'Payment',
      attachmentCount: 2,
    })
    expect(mapExplanation({ ...base, attachment: { url: 'x' } }).attachmentCount).toBe(1)
    expect(mapExplanation(base).attachmentCount).toBe(0)
  })
})

describe('everything else', () => {
  it('flattens the four category lists, keeping which one each came from', () => {
    const rows = mapCategories({
      admin_expenses_categories: [
        {
          url: `${API}/categories/285`,
          description: 'Accommodation and Meals',
          nominal_code: '285',
          allowable_for_tax: true,
          auto_sales_tax_rate: 'Standard rate',
        },
      ],
      income_categories: [
        { url: `${API}/categories/001`, description: 'Sales', nominal_code: '001' },
      ],
      general_categories: [
        { url: `${API}/categories/750`, description: 'Loan', nominal_code: '750' },
      ],
    })
    expect(rows.map(r => [r.nominalCode, r.kind])).toEqual([
      ['285', 'admin_expenses'],
      ['001', 'income'],
      ['750', 'general'],
    ])
    expect(rows[0]).toMatchObject({ allowableForTax: true, autoSalesTaxRate: 'Standard rate' })
  })

  it('names a contact by organisation, else by person', () => {
    expect(
      mapContact({ url: `${API}/contacts/1`, organisation_name: 'Acme Ltd', first_name: 'A' })
        .displayName
    ).toBe('Acme Ltd')
    expect(
      mapContact({ url: `${API}/contacts/2`, first_name: 'Ada', last_name: 'Lovelace' }).displayName
    ).toBe('Ada Lovelace')
  })

  it('maps bills, invoices, accounts and the company', () => {
    expect(
      mapInvoice({
        url: `${API}/invoices/1`,
        contact: `${API}/contacts/1`,
        reference: 'INV-001',
        dated_on: '2026-09-01',
        due_on: '2026-10-01',
        status: 'Open',
        total_value: '1200.0',
        paid_value: '0.0',
        due_value: '1200.0',
      })
    ).toMatchObject({
      reference: 'INV-001',
      totalValue: '1200.0',
      dueValue: '1200.0',
      dueOn: '2026-10-01',
    })
    expect(
      mapBill({ url: `${API}/bills/1`, total_value: '50', sales_tax_value: '8.33' })
    ).toMatchObject({ totalValue: '50', salesTaxValue: '8.33' })
    expect(
      mapBankAccount({
        url: `${API}/bank_accounts/1`,
        name: 'Current',
        current_balance: '10.5',
        is_primary: true,
      })
    ).toMatchObject({ name: 'Current', currentBalance: '10.5', isPrimary: true })
    expect(
      mapCompany({ company: { url: `${API}/company`, name: 'GuideMode Ltd', currency: 'GBP' } })
    ).toEqual({
      companyUrl: `${API}/company`,
      companyName: 'GuideMode Ltd',
      companyCurrency: 'GBP',
    })
  })

  it('calls something overdue only when it is owed and past due', () => {
    const today = '2026-10-24'
    expect(isOverdue({ status: 'Open', dueOn: '2026-10-01', dueValue: '10.0' }, today)).toBe(true)
    expect(isOverdue({ status: 'Open', dueOn: '2026-11-01', dueValue: '10.0' }, today)).toBe(false)
    expect(isOverdue({ status: 'Open', dueOn: '2026-10-01', dueValue: '0.0' }, today)).toBe(false)
    expect(isOverdue({ status: 'Draft', dueOn: '2026-10-01', dueValue: '10.0' }, today)).toBe(false)
    expect(isOverdue({ status: 'Overdue', dueOn: null, dueValue: null }, today)).toBe(true)
  })
})
