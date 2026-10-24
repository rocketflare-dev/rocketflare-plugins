---
version: unreleased
previous: 3.6.0
date: null
breaking: false
migrations:
  - inbox_messages — five new columns, all nullable or defaulted, no backfill: parent_message_id (uuid, self-FK ON DELETE SET NULL), forwarded_by (text), forward_depth (integer NOT NULL DEFAULT 0), source_sha256 (text), forwarded_count (integer NOT NULL DEFAULT 0); partial unique index inbox_messages_tenant_parent_part_uidx on (tenant_id, parent_message_id, source_sha256) WHERE parent_message_id IS NOT NULL
  - inbox_attachments — one new column, expanded_message_id (uuid, FK to inbox_messages ON DELETE SET NULL)
areas: [api, ui]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Forwarded-as-attachment email is split: each embedded `message/rfc822` part becomes an inbox message of its own, so consumers and the knowledge base see one message per forwarded email instead of an `.eml` attachment they skip.

- `inbox.parse` runs postal-mime with `forceRfc822Attachments`, so an embedded message with no `Content-Disposition` is no longer merged into the parent's body.
- Each embedded message becomes a child row (`parent_message_id`), with its raw bytes under its own `tenants/<id>/inbox/<child id>/` prefix, its own From, Subject, Date and Message-ID, and its own `inbox.parse` job. It inherits the parent's SPF/DKIM/DMARC verdict, because its own signatures can't be checked once it has been re-wrapped, and `forwarded_by` records the forward's envelope sender.
- The parent keeps the `.eml` attachment row, with `expanded_message_id` pointing at the message it became. These rows are left out of consumer `attachments`, knowledge ingestion and `attachment_count`, and `forwarded_count` counts them instead.
- Dedupe works without memory. The unique `(tenant_id, parent_message_id, source_sha256)` index stops a redelivered or reprocessed parent from creating a second child. An embedded Message-ID the organisation already has is linked to the existing message instead of being stored again.
- Caps: nesting stops at depth 3 (`INBOX_FORWARD_MAX_DEPTH`), where parts stay plain `.eml` attachments. A message is split into at most 50 children (`INBOX_FORWARD_MAX_CHILDREN`), and the message's `error` says how many were kept as attachments.
- `InboxParsedMessage` (the `inbox:consumers` payload) gains `parentMessageId`, `forwardedBy` and `forwardedMessageIds`. The change is additive, and a consumer is still called once per message, which now means once per embedded email.
- API: message summaries gain `parentMessageId`, `forwardedBy` and `forwardedCount`. A message's detail gains `parent`, `forwardedMessages` and, on each attachment, `expandedMessageId`. Agent tools report `forwardedInside` / `forwardedMessageIds`.
- UI: the Inbox list marks children and shows "N forwarded" on a parent. A message shows "Forwarded inside …" or "Contains N forwarded emails", with links between them.
- The duplicated `docs/plugins/inbox/upgrades/` copy inside the plugin directory is removed. A host's `docs/plugins/inbox/upgrades/` now comes only from the plugin's `docs/upgrades/`.

## How to apply

1. `pnpm plugin upgrade inbox --apply`.
2. `pnpm db:generate --name plugin-inbox-<version>`. Read the SQL: six `ALTER TABLE … ADD COLUMN`, two foreign keys and one partial unique index. There are no data changes. Then run `pnpm db:migrate`.
3. Optional: messages received before the upgrade aren't split. Reprocess one from the Inbox page or `POST /api/inbox/messages/:id/reprocess` to split it. Children are created once, however often it runs.

## Conflicts to expect

`services/parse.ts`, `api/routes.ts`, `ui/pages/InboxPage.tsx` and `packages/shared/src/plugins/inbox/index.ts` change, so a host that edited them gets conflicts there. A consumer that builds `InboxParsedMessage` objects by hand (in tests, for example) must add the three new fields.

## Verify

1. `pnpm plugin check` passes.
2. `pnpm gate` passes, including `src/plugins/inbox/tests/api/forwarded.test.ts`.
3. Use Gmail's "Forward as attachment" to send two receipts to the inbox address. The Inbox page shows the forward with "Contains 2 forwarded emails" and two messages with the receipts' own senders.
