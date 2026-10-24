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
- **Forwarded as attachment** (`services/forwarded.ts`): postal-mime runs with
  `forceRfc822Attachments`, so every `message/rfc822` part — with or without a disposition — is
  an attachment, never merged into the parent body. Each becomes a CHILD message: its own row
  (`parent_message_id`, `forward_depth`, `source_sha256`), its own R2 prefix, the embedded
  headers (read from the header block only), the PARENT's `auth` (the inner signatures cannot be
  verified) and `forwarded_by` (the top-level envelope sender), then its own `inbox.parse`. The
  parent keeps the `.eml` row with `expanded_message_id` set; such rows are excluded from consumer
  `attachments`, knowledge and the parent's `attachment_count`. Idempotency is the unique
  `(tenant_id, parent_message_id, source_sha256)` index plus the per-tenant Message-ID index (an
  email already received is LINKED, not stored again) — never memory. Caps:
  `INBOX_FORWARD_MAX_DEPTH` (3; at the cap parts stay plain `.eml`s) and
  `INBOX_FORWARD_MAX_CHILDREN` (50 per message; the rest stay attachments and the message's
  `error` says so). A child still `received` when its parent is re-run is re-enqueued, so a
  failed enqueue cannot strand it — consumers must tolerate the rare second call. Deleting a
  parent leaves its children (`parent_message_id` is `set null`); each is deleted on its own.
- **Consumers** (`InboxConsumer`, exported from `index.ts`) are called for `kind = 'message'` only,
  never for forwarding confirmations — once per message, so once per embedded email (a child
  carries `parentMessageId`/`forwardedBy`; a parent lists `forwardedMessageIds`). A consumer's
  throw is logged and written to the message's `error`; it does not stop the others and does not
  retry the job.
- **Knowledge** (`services/knowledge.ts`): after consumers, a parsed message (headers + text) and
  each non-image attachment are ingested with `source: 'inbox:message' | 'inbox:attachment'` and the
  row's id as `externalId` — upserts, so a reprocess is safe. Best-effort: failures land on the
  message's `error`, never fail the job. Files need an owner: the settings' last editor, else the
  oldest owner. Deleting a message calls `forgetMessage` BEFORE the rows go (the ids are the keys).
- **Forwarding confirmations** (Gmail's `forwarding-noreply@google.com`, Proton domains) are
  accepted before the allow-list names anyone — that is the only way to read the code — but must
  still authenticate. Logic and tables: `services/rules.ts`, `tests/config/rules.test.ts`.
