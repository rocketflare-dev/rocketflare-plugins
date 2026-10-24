/**
 * `rocketflare inbox …` — the plugin's CLI half.
 *
 *   rocketflare inbox list [--status parsed|received|failed] [--json]   GET /api/inbox/messages
 *   rocketflare inbox status [--json]                                   GET /api/inbox/settings
 */
import {
  INBOX_ID,
  inboxMessageListResponseSchema,
  inboxSettingsSchema,
  inboxShared,
} from '@rocketflare/shared/plugins/inbox/index'
import type { CliPlugin, CommandContext } from '../api'
import { formatDate, renderTable, requireClient } from '../api'

export async function runInboxList(
  ctx: CommandContext,
  options: { status?: string }
): Promise<void> {
  const query = options.status ? `?status=${encodeURIComponent(options.status)}` : ''
  const { data, raw } = await requireClient(ctx).request('GET', `/api/inbox/messages${query}`, {
    schema: inboxMessageListResponseSchema,
  })
  ctx.out.data(raw, () =>
    data.items.length === 0
      ? 'No messages.'
      : renderTable(data.items, [
          { header: 'Received', value: m => formatDate(m.receivedAt) },
          { header: 'From', value: m => m.fromAddress ?? m.envelopeFrom },
          { header: 'Subject', value: m => m.subject },
          { header: 'Files', value: m => m.attachmentCount },
          { header: 'Status', value: m => m.status },
        ])
  )
}

export async function runInboxStatus(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/inbox/settings', {
    schema: inboxSettingsSchema,
  })
  ctx.out.data(raw, () =>
    [
      `Inbox:           ${data.enabled ? 'on' : 'off'}`,
      `Address:         ${data.localPart ?? 'not set'}`,
      `Allowed senders: ${data.allowedSenders.length ? data.allowedSenders.join(', ') : 'none'}`,
      `Authentication:  ${data.requireAuthentication ? 'required' : 'not required'}`,
    ].join('\n')
  )
}

export const inboxCli: CliPlugin<typeof inboxShared> = {
  shared: inboxShared,
  register(program, action) {
    const root = program.command(INBOX_ID).description('inbound email (a plugin)')
    root
      .command('list', { isDefault: true })
      .description('list received messages, newest first')
      .option('--status <status>', 'received | parsed | failed')
      .action(action((ctx, cmd) => runInboxList(ctx, cmd.opts())))
    root
      .command('status')
      .description('show the inbox address and allow-list')
      .action(action(ctx => runInboxStatus(ctx)))
  },
}
