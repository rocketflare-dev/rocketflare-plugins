# inbox

> Inbound email for your app: forward receipts, invoices and notices to an address on your domain
> and they arrive parsed, with their attachments, ready for other plugins to act on.

Mail reaches the Worker through **Cloudflare Email Routing** and the kit's `email` entry. Each
organisation picks a local part (`receipts`). Mail to `receipts@<your domain>`, or
`receipts+anything@`, is checked against the organisation's sender allow-list and the SPF, DKIM
and DMARC verdicts Cloudflare recorded. Accepted mail is stored raw in R2 and parsed in a queued
job. Other plugins subscribe to parsed messages through the `inbox:consumers` extension.

## What it adds

| Area | What you get |
|---|---|
| Email | A catch-all `emailHandlers` entry. Unknown addresses, senders that aren't allowed and failed authentication are bounced with a reason the forwarding mailbox shows |
| UI | **Inbox**: messages, sender and forwarder, authentication verdicts, text body, attachments, raw/HTML downloads, reprocess and delete. **Settings → Inbox**: address, allow-list, require authentication, on/off |
| Forward as attachment | Each `message/rfc822` part of a message (Gmail's "Forward as attachment", with or without a disposition) becomes a **message of its own**, linked to the forward it came in: its own sender, subject, date and attachments, the forward's authentication verdict, and who forwarded it. An embedded email already received is linked, not stored again. Nesting stops at 3 levels and 50 emails per message |
| Forwarding | Gmail and Proton forwarding confirmations are let through before anyone is allow-listed, and their **code and link** are shown at the top of the message |
| Knowledge | Each parsed message (headers + text) and its PDF/Office/HTML/text attachments are indexed into the kit's knowledge base (`inbox:message`, `inbox:attachment`), so chat can search your mail. Upserted on reprocess, removed on delete, switchable in Settings |
| Agent tools | `inbox_list_messages` and `inbox_get_message`, both read-only |
| Extension | `inbox:consumers`: a plugin contributes `{ id, onMessage(message, ctx) }` and is called once per parsed message — so once per embedded email of a forward — with attachment refs it reads through `readInboxAttachment`, and `parentMessageId` / `forwardedBy` / `forwardedMessageIds` for forwarded mail |
| API | `GET/PUT /api/inbox/settings`, `GET /api/inbox/messages`, `GET /api/inbox/messages/:id`, `…/:id/raw`, `…/:id/html`, `GET /api/inbox/attachments/:id`, `POST …/:id/reprocess`, `DELETE …/:id` |
| Data | `inbox_settings`, `inbox_messages` and `inbox_attachments`, all with row-level security. Bytes live in R2 under `tenants/<id>/inbox/` and are purged with the tenant |
| CLI | `rocketflare inbox list [--status]` and `rocketflare inbox status` |
| Skill | `/inbox`: Email Routing setup, Gmail and Proton forwarding, testing, troubleshooting |

## Requirements

- Rocketflare kit **0.22.0** or later (the `emailHandlers` slot and `storage()` on background contexts).
- The receiving domain on Cloudflare, with Email Routing enabled and a rule that sends the address to the Worker.
- The kit's `FILES` (R2) and `JOBS_QUEUE` bindings, which every kit app already has, and its knowledge surface (`feature-knowledge`) for indexing.

## Install

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.6.0 --subdir plugins/inbox
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.6.0 --subdir plugins/inbox --apply
pnpm db:generate --name plugin-inbox-<version> && pnpm db:migrate
```

Then run `/inbox setup`.

## Building on it

```ts
import { inboxExtensions } from '@rocketflare/shared/plugins/inbox/index'
import { type InboxConsumer, readInboxAttachment } from '@/plugins/inbox'

const receipts: InboxConsumer = {
  id: 'receipts',
  async onMessage(message, ctx) {
    // Quick and idempotent: enqueue your own job, keyed on message.messageId.
    await ctx.enqueue({ type: 'receipts.extract', payload: { tenantId: message.tenantId, messageId: message.messageId } })
  },
}

export const receiptsServer = {
  // …
  extensions: inboxExtensions({ consumers: [receipts] }),
}
```

Declare `requires: { plugins: ["inbox"] }` in your `plugin.json`.

## Who sees what

Every member can read the inbox and its attachments. Owners and admins change the settings, reprocess messages and delete them.

## Known gaps

- Bounced messages aren't stored or listed. The bounce reason goes only to the forwarding mailbox and the Worker log.
- One local part per organisation.
- No outbound replies.
- The routing rule is a manual dashboard step; provisioning doesn't create it.
- The HTML body is a download only and is never rendered in the app.
- A message split out of a forward carries the forward's SPF/DKIM/DMARC verdict; its own signatures can't be checked once it has been re-wrapped.
- Messages received before 3.7.0 aren't split until they are reprocessed.
