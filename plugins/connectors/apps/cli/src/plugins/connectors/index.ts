/**
 * `rocketflare connectors …` — the plugin's CLI half.
 *
 *   rocketflare connectors status [--json]                        GET  /api/connectors/installations
 *   rocketflare connectors sync [--provider <id>] [--resource r]  POST /api/connectors/installations/:id/sync
 *
 * Connecting is deliberately NOT here: admin consent is a browser round trip through the provider,
 * and a CLI that opened it would still need the browser to finish. `status` and `sync` are what an
 * operator reaches for from a shell. Every response is parsed with the shared schema the server
 * validated with, and failures throw `CliError` for the host's one error printer.
 */
import {
  CONNECTOR_RESOURCES,
  CONNECTORS_ID,
  type ConnectorResource,
  connectorInstallationListResponseSchema,
  connectorsShared,
  syncInstallationResponseSchema,
} from '@rocketflare/shared/plugins/connectors/index'
import type { CliPlugin, CommandContext } from '../api'
import { CliError, EXIT_ERROR, formatDate, renderTable, requireClient } from '../api'

export async function runConnectorsStatus(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/connectors/installations', {
    schema: connectorInstallationListResponseSchema,
  })
  ctx.out.data(raw, () => {
    if (data.items.length === 0) return 'No connections. Connect one in Settings → Connections.'
    return data.items
      .map(i =>
        [
          `${i.provider}: ${i.status}${i.displayName ? ` — ${i.displayName}` : ''}`,
          `  people ${i.counts.users} (${i.counts.matchedUsers} members) · groups ${i.counts.groups} · calendars ${i.counts.mailboxes} · events ${i.counts.events}`,
          ...(i.lastError ? [`  error: ${i.lastError}`] : []),
          renderTable(i.cursors, [
            { header: 'Resource', value: c => c.resource },
            { header: 'Cursors', value: c => String(c.count) },
            {
              header: 'Last synced',
              value: c => (c.lastSyncedAt ? formatDate(c.lastSyncedAt) : 'never'),
            },
            { header: 'Backfilling', value: c => String(c.backfilling) },
            { header: 'Failing', value: c => String(c.failing) },
          ]),
        ].join('\n')
      )
      .join('\n\n')
  })
}

export async function runConnectorsSync(
  ctx: CommandContext,
  options: { provider?: string; resource?: string }
): Promise<void> {
  if (options.resource && !(CONNECTOR_RESOURCES as readonly string[]).includes(options.resource)) {
    throw new CliError(`Unknown resource "${options.resource}"`, {
      exitCode: EXIT_ERROR,
      hint: `one of: ${CONNECTOR_RESOURCES.join(', ')}`,
    })
  }
  const client = requireClient(ctx)
  const { data } = await client.request('GET', '/api/connectors/installations', {
    schema: connectorInstallationListResponseSchema,
  })
  const targets = data.items.filter(
    i => i.status !== 'pending' && (!options.provider || i.provider === options.provider)
  )
  if (targets.length === 0) {
    throw new CliError('No connected installation matches', {
      exitCode: EXIT_ERROR,
      hint: 'run `rocketflare connectors status`',
    })
  }
  const results: { provider: string; queued: number }[] = []
  for (const installation of targets) {
    const body: { resource?: ConnectorResource } = options.resource
      ? { resource: options.resource as ConnectorResource }
      : {}
    const { data: queued } = await client.request(
      'POST',
      `/api/connectors/installations/${installation.id}/sync`,
      { body, schema: syncInstallationResponseSchema }
    )
    results.push({ provider: installation.provider, queued: queued.queued })
  }
  ctx.out.data(results, () =>
    results.map(r => `${r.provider}: queued ${r.queued} sync job(s)`).join('\n')
  )
}

export const connectorsCli: CliPlugin<typeof connectorsShared> = {
  shared: connectorsShared,
  register(program, action) {
    const root = program
      .command(CONNECTORS_ID)
      .description('Microsoft 365 / Google Workspace connections (a plugin)')
    root
      .command('status', { isDefault: true })
      .description('each connection, its counts and its sync progress')
      .action(action(ctx => runConnectorsStatus(ctx)))
    root
      .command('sync')
      .description('enqueue a sync of every connected installation now')
      .option('--provider <id>', 'only this provider (e.g. m365)')
      .option('--resource <resource>', `only one of: ${CONNECTOR_RESOURCES.join(', ')}`)
      .action(
        action((ctx, command) =>
          runConnectorsSync(ctx, command.opts<{ provider?: string; resource?: string }>())
        )
      )
  },
}
