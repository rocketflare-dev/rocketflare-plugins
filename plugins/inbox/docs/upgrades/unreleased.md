---
version: unreleased
previous: 3.8.2
date: null
breaking: true
migrations:
  - "inbox_settings.confirmation_window_until"
  - "inbox_messages.root_message_id and forward_tree_count"
  - "inbox_local_part_holds table (no tenant column, RLS-excluded)"
areas: [api, ui, db, cli]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Inbox tightens which senders it accepts, bounds how far one delivery can split, and holds released addresses for 90 days.

- Mail is accepted only when the passing SPF, DKIM or DMARC result is for the allow-listed identity.
- Authentication-Results is read only from the receiving edge's header (authserv-id `mx.cloudflare.net`), per method and position.
- One RFC 5322 parser decides the allow-list and the stored sender; a From header holding a list, a group or no mailbox matches nothing.
- Forwarding confirmations are accepted ahead of the allow-list only in a 24-hour setup window and must authenticate as the provider's domain; links are kept only on the provider's host.
- One delivery splits into at most 50 messages across all depths (`INBOX_FORWARD_MAX_TOTAL`).
- A released local part stays with its organisation for 90 days (`INBOX_LOCAL_PART_HOLD_DAYS`, 409 `inbox_local_part_taken`).
- The agent tools state that message content is sender-written.
- `rocketflare inbox status` neutralises server values.

## How to apply

1. Install on kit 0.29.0 or later, which carries the plugin entries this version imports.
2. Run `pnpm db:generate --name plugin-inbox-<version>` and `pnpm db:migrate`.
3. Seed holds for addresses in use today: `INSERT INTO inbox_local_part_holds (local_part, holder_tenant_id) SELECT local_part, tenant_id FROM inbox_settings WHERE local_part IS NOT NULL ON CONFLICT (local_part) DO NOTHING`.
4. Check one real Email Routing delivery on staging carries authserv-id `mx.cloudflare.net`, because mail needing authentication is refused without it.
5. To confirm a forwarding address after its first 24 hours, open the setup window in Settings → Inbox.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` passes.
2. A message from an allow-listed From whose SPF passes for another domain is refused.
