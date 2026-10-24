/**
 * `rocketflare freeagent …` — the plugin's CLI half.
 *
 *   rocketflare freeagent status [--json]   GET  /api/freeagent/status
 *   rocketflare freeagent sync [--json]     POST /api/freeagent/sync   (queues a sync; admin)
 */
import {
  FREEAGENT_ID,
  freeagentShared,
  freeagentStatusSchema,
  freeagentSyncResponseSchema,
} from '@rocketflare/shared/plugins/freeagent/index'
import type { CliPlugin, CommandContext } from '../api'
import { formatDate, requireClient } from '../api'

export async function runFreeagentStatus(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/freeagent/status', {
    schema: freeagentStatusSchema,
  })
  const connection = data.connected
    ? 'connected'
    : data.status === 'needs_reconnect'
      ? 'needs reconnecting (Settings → FreeAgent)'
      : 'not connected'
  ctx.out.data(raw, () =>
    [
      `FreeAgent:     ${data.configured ? `configured (${data.environment})` : 'not configured on this deployment'}`,
      `Connection:    ${connection}`,
      `Company:       ${data.companyName ?? '-'}${data.companyCurrency ? ` (${data.companyCurrency})` : ''}`,
      `Last sync:     ${formatDate(data.lastSyncAt)}`,
      `Mirrored:      ${data.counts.transactions} transactions (${data.counts.unexplained} unexplained), ${data.counts.invoices} invoices, ${data.counts.bills} bills`,
      ...(data.lastError
        ? [`Last error:    ${data.lastError} (${formatDate(data.lastErrorAt)})`]
        : []),
    ].join('\n')
  )
}

export async function runFreeagentSync(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('POST', '/api/freeagent/sync', {
    schema: freeagentSyncResponseSchema,
  })
  ctx.out.data(raw, () => `Sync queued (job ${data.jobId}).`)
}

export const freeagentCli: CliPlugin<typeof freeagentShared> = {
  shared: freeagentShared,
  register(program, action) {
    const root = program.command(FREEAGENT_ID).description('FreeAgent accounting (a plugin)')
    root
      .command('status', { isDefault: true })
      .description('show the connection, company and last sync')
      .action(action(ctx => runFreeagentStatus(ctx)))
    root
      .command('sync')
      .description('queue a sync of the FreeAgent books now')
      .action(action(ctx => runFreeagentSync(ctx)))
  },
}
