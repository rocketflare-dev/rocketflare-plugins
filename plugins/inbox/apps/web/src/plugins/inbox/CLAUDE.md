# inbox plugin — rules for this directory

Inbound email for an organisation: Cloudflare Email Routing → the kit's `email` entry →
`emailHandlers` (this plugin claims `*`) → `services/receive.ts` → R2 + `inbox_messages` →
`inbox.parse` → `services/parse.ts` → every `inbox:consumers` extension.

- **`email()` stays cheap.** `receiveMessage` decides (address → organisation, allow-list,
  authentication), stores the raw bytes, writes ONE row and enqueues. No MIME parsing there —
  that is `inbox.parse`, which has the queue's retries and its own CPU budget.
- **Refuse before you write.** Every rejection is `message.setReject(reason)` (a permanent bounce
  the forwarding mailbox shows its owner) and happens before any R2 or Postgres write. A throw
  AFTER the decision is rethrown by the kit as a temporary failure, so the sender retries.
- **The one unscoped query** is `settingsForLocalPart` — a message names an address, not a
  tenant. It is in `unscopedAllowlist` with its reason; every other query carries `tenant_id`.
- **R2 keys live under `tenants/<id>/inbox/<message id>/`** (`messagePrefix`), so the kit's
  tenant purge removes them and deleting a message is one prefix.
- **Never render a body.** The HTML body and raw `.eml` are served as `attachment` with
  `nosniff`; the UI shows the text body only. These are bytes a stranger chose.
- **Parse is idempotent.** Attachments are unique per (message, sha256) and upserted, so a
  reprocess keeps attachment ids a consumer may have stored. Consumers must be idempotent too.
- **Consumers** (`InboxConsumer`, exported from `index.ts`) are called for `kind = 'message'` only,
  never for forwarding confirmations. A consumer's throw is logged and written to the message's
  `error`; it does not stop the others and does not retry the job.
- **Forwarding confirmations** (Gmail's `forwarding-noreply@google.com`, Proton domains) are
  accepted before the allow-list names anyone — that is the only way to read the code — but must
  still authenticate. Logic and tables: `services/rules.ts`, `tests/config/rules.test.ts`.
