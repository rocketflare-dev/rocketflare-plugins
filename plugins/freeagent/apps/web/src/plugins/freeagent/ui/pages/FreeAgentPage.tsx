/**
 * FreeAgent: the organisation's unexplained bank transactions and its recent invoices, from the
 * mirror. Two plain tables — the place to see what a receipts matcher (or a person) still has to
 * explain, and who still owes money. Amounts are shown exactly as FreeAgent sent them.
 */
import { BanknotesIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import {
  EmptyState,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
  timeAgo,
} from '@/plugins/api/ui'
import {
  useFreeAgentInvoices,
  useFreeAgentStatus,
  useFreeAgentTransactions,
} from '../hooks/useFreeAgent'

function Money({ value, currency }: { value: string | null; currency?: string | null }) {
  if (value === null) return <span className="opacity-50">—</span>
  const negative = value.trim().startsWith('-')
  return (
    <span className={`font-mono tabular-nums ${negative ? 'text-error' : ''}`}>
      {value}
      {currency ? ` ${currency}` : ''}
    </span>
  )
}

export default function FreeAgentPage() {
  const status = useFreeAgentStatus()
  const connected = status.data?.status != null
  return (
    <div className="space-y-4">
      <PageHeader
        title="FreeAgent"
        description={
          status.data?.companyName
            ? `${status.data.companyName} · last synced ${timeAgo(status.data.lastSyncAt)}`
            : 'Your FreeAgent books, mirrored every 30 minutes. Connect in Settings → FreeAgent.'
        }
      />
      {status.isPending ? (
        <SectionPanel>
          <SkeletonRows rows={6} />
        </SectionPanel>
      ) : !connected ? (
        <SectionPanel>
          <EmptyState
            icon={BanknotesIcon}
            message="FreeAgent is not connected"
            description="An admin connects the organisation's FreeAgent company in Settings → FreeAgent."
          />
        </SectionPanel>
      ) : (
        <>
          <UnexplainedTransactions />
          <RecentInvoices />
        </>
      )}
    </div>
  )
}

function UnexplainedTransactions() {
  const [page, setPage] = useState(1)
  const list = useFreeAgentTransactions({ unexplained: 'true', page, pageSize: 25 })
  return (
    <SectionPanel title="Unexplained transactions" flush>
      {list.isPending ? (
        <div className="p-4">
          <SkeletonRows rows={5} />
        </div>
      ) : list.isError || !list.data ? (
        <p className="p-4 text-sm text-error">The transactions could not be loaded.</p>
      ) : list.data.items.length === 0 ? (
        <p className="p-4 text-sm opacity-70">Everything is explained.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Account</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Unexplained</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map(t => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap">{t.datedOn}</td>
                    <td className="max-w-md truncate">{t.description ?? '—'}</td>
                    <td>{t.bankAccountName ?? '—'}</td>
                    <td className="text-right">
                      <Money value={t.amount} />
                    </td>
                    <td className="text-right">
                      <Money value={t.unexplainedAmount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            className="p-3"
            pagination={list.data.pagination}
            onPageChange={setPage}
          />
        </>
      )}
    </SectionPanel>
  )
}

function RecentInvoices() {
  const [page, setPage] = useState(1)
  const [overdue, setOverdue] = useState(false)
  const list = useFreeAgentInvoices({ page, pageSize: 25, ...(overdue && { overdue: 'true' }) })
  return (
    <SectionPanel
      title="Invoices"
      flush
      actions={
        <label className="label cursor-pointer gap-2 text-sm">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={overdue}
            onChange={e => {
              setOverdue(e.target.checked)
              setPage(1)
            }}
          />
          Overdue only
        </label>
      }
    >
      {list.isPending ? (
        <div className="p-4">
          <SkeletonRows rows={5} />
        </div>
      ) : list.isError || !list.data ? (
        <p className="p-4 text-sm text-error">The invoices could not be loaded.</p>
      ) : list.data.items.length === 0 ? (
        <p className="p-4 text-sm opacity-70">
          {overdue ? 'Nothing is overdue.' : 'No invoices yet.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Client</th>
                  <th>Dated</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Still due</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map(i => (
                  <tr key={i.id}>
                    <td>{i.reference ?? '—'}</td>
                    <td>{i.contactName ?? '—'}</td>
                    <td className="whitespace-nowrap">{i.datedOn ?? '—'}</td>
                    <td className="whitespace-nowrap">{i.dueOn ?? '—'}</td>
                    <td>
                      <span
                        className={`badge badge-sm ${i.overdue ? 'badge-error' : 'badge-ghost'}`}
                      >
                        {i.overdue ? 'Overdue' : (i.status ?? '—')}
                      </span>
                    </td>
                    <td className="text-right">
                      <Money value={i.totalValue} currency={i.currency} />
                    </td>
                    <td className="text-right">
                      <Money value={i.dueValue} currency={i.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            className="p-3"
            pagination={list.data.pagination}
            onPageChange={setPage}
          />
        </>
      )}
    </SectionPanel>
  )
}
