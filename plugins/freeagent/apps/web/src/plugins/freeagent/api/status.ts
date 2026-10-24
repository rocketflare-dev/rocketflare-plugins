/**
 * The status Settings, the CLI and the `freeagent_company` tool all show: is the deployment set up,
 * is this organisation connected, to which company, when did it last sync and what went wrong.
 * Never a token — `hasCredential`-style, the browser learns only that one exists.
 */
import type {
  FreeAgentEnvironment,
  FreeAgentStatus,
} from '@rocketflare/shared/plugins/freeagent/index'
import { and, count, eq } from 'drizzle-orm'
import type { Database, PluginConfig } from '@/plugins/api'
import {
  freeagentBankAccounts,
  freeagentBankTransactions,
  freeagentBills,
  freeagentInvoices,
} from '../db/schema'
import { loadConnection } from '../services/connection'
import { appCredentials, freeagentConfig } from '../services/env'

export async function loadStatus(
  db: Database,
  config: PluginConfig,
  tenantId: string
): Promise<FreeAgentStatus> {
  const connection = await loadConnection(db, tenantId)
  const total = async (
    table: typeof freeagentBills | typeof freeagentInvoices | typeof freeagentBankAccounts
  ) => {
    const t = table as typeof freeagentBills
    const [row] = await db.select({ n: count() }).from(t).where(eq(t.tenantId, tenantId))
    return row?.n ?? 0
  }
  const [transactions, unexplained] = connection
    ? await Promise.all([
        db
          .select({ n: count() })
          .from(freeagentBankTransactions)
          .where(eq(freeagentBankTransactions.tenantId, tenantId)),
        db
          .select({ n: count() })
          .from(freeagentBankTransactions)
          .where(
            and(
              eq(freeagentBankTransactions.tenantId, tenantId),
              eq(freeagentBankTransactions.isUnexplained, true)
            )
          ),
      ])
    : [[], []]
  return {
    configured: appCredentials(config) !== null,
    environment: freeagentConfig(config).FREEAGENT_ENVIRONMENT,
    connected: connection?.status === 'connected',
    status: (connection?.status as FreeAgentStatus['status']) ?? null,
    connectionEnvironment: (connection?.environment as FreeAgentEnvironment | undefined) ?? null,
    companyName: connection?.companyName ?? null,
    companyCurrency: connection?.companyCurrency ?? null,
    connectedAt: connection?.connectedAt ?? null,
    lastSyncAt: connection?.lastSyncAt ?? null,
    lastSyncStartedAt: connection?.lastSyncStartedAt ?? null,
    lastError: connection?.lastError ?? null,
    lastErrorAt: connection?.lastErrorAt ?? null,
    counts: connection
      ? {
          bankAccounts: await total(freeagentBankAccounts),
          transactions: transactions[0]?.n ?? 0,
          unexplained: unexplained[0]?.n ?? 0,
          invoices: await total(freeagentInvoices),
          bills: await total(freeagentBills),
        }
      : { bankAccounts: 0, transactions: 0, unexplained: 0, invoices: 0, bills: 0 },
  }
}
