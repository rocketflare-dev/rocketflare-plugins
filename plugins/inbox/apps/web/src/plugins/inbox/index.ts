/**
 * `inbox` — the server entry (D31). Read top to bottom: the catch-all email handler, the one job,
 * the authed mount, two read-only agent tools, and the grants. What it exports beyond the
 * `ServerPlugin` is the consumer contract — `InboxConsumer`, `InboxParsedMessage` and the two
 * readers — which is how another plugin (a receipts matcher, a ticketing bridge) builds on mail.
 *
 * The handler claims `*`: Email Routing decides which addresses reach the Worker at all, and this
 * plugin decides which ORGANISATION an address belongs to (`inbox_settings.local_part`). A plugin
 * that wants a dedicated address of its own claims that local part exactly, which wins over `*`.
 */
import {
  INBOX_MESSAGE_SUBJECT,
  INBOX_PARSE_JOB,
  INBOX_SETTINGS_SUBJECT,
  inboxShared,
} from '@rocketflare/shared/plugins/inbox/index'
import type { ServerPlugin, Tool } from '@/plugins/api'
import { EMAIL_CATCH_ALL, emailCtx, toolCtx } from '@/plugins/api'
import { inboxRouter } from './api/routes'
import { handleInboxParse } from './jobs/parse'
import { receiveMessage } from './services/receive'
import { getInboxMessageTool, listInboxMessagesTool } from './tools/inbox-tools'

export type { InboxAttachmentRef, InboxConsumer, InboxParsedMessage } from './services/parse'
export { readInboxAttachment, readInboxHtml } from './services/parse'

export const inboxServer = {
  shared: inboxShared,
  mounts: [['/api/inbox', inboxRouter]],
  emailHandlers: [
    {
      localPart: EMAIL_CATCH_ALL,
      name: 'inbox',
      handle: async (message, raw) => {
        const ctx = emailCtx(raw)
        await receiveMessage(message, ctx, {
          authenticationOptional: ctx.config.APP_ENV === 'development',
        })
      },
    },
  ],
  jobHandlers: { [INBOX_PARSE_JOB]: handleInboxParse },
  agentTools: raw => {
    const ctx = toolCtx(raw)
    return [listInboxMessagesTool(ctx) as Tool, getInboxMessageTool(ctx) as Tool]
  },
  /** Additive, over this plugin's own subjects: admins configure and tidy, members read. */
  grants: {
    owner: can => {
      can('manage', INBOX_MESSAGE_SUBJECT)
      can('manage', INBOX_SETTINGS_SUBJECT)
    },
    admin: can => {
      can('manage', INBOX_MESSAGE_SUBJECT)
      can('manage', INBOX_SETTINGS_SUBJECT)
    },
    support: can => {
      can('read', INBOX_MESSAGE_SUBJECT)
      can('read', INBOX_SETTINGS_SUBJECT)
    },
    member: can => {
      can('read', INBOX_MESSAGE_SUBJECT)
      can('read', INBOX_SETTINGS_SUBJECT)
    },
  },
  unscopedAllowlist: {
    'src/plugins/inbox/services/receive.ts':
      'settingsForLocalPart resolves the organisation FROM the recipient address — an inbound ' +
      'message names no tenant, and the unique index on local_part makes the answer one row.',
  },
} satisfies ServerPlugin<typeof inboxShared>
