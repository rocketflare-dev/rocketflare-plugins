---
name: inbox
description: Set up, verify and troubleshoot inbound email with the `inbox` plugin — Cloudflare Email Routing to this Worker, the organisation's inbox address and sender allow-list, Gmail and Proton auto-forwarding (including the forwarding confirmation code), and messages that bounce, never arrive or fail to parse. Use when someone asks to receive or forward email into the app, set up an address like receipts@…, configure Email Routing, confirm Gmail forwarding, or asks why a forwarded message was rejected or is missing.
argument-hint: "[explain | setup | forward-gmail | forward-proton | test | troubleshoot]"
---

# /inbox — inbound email, set up end to end

The `inbox` plugin receives email through **Cloudflare Email Routing** and the kit's `email`
Worker entry. Each organisation picks a **local part** (`receipts`), and mail to
`receipts@<routed domain>` — or `receipts+anything@` — is checked, stored and parsed. Other plugins
subscribe to parsed messages (`inbox:consumers`). Rules for the code:
`apps/web/src/plugins/inbox/CLAUDE.md`; the kit side: `docs/DEPLOY.md` § Inbound email.

`$ARGUMENTS` picks the mode. With none: run **Status** below, then ask which mode they need.

## Rules

- Anything in the Cloudflare dashboard, Gmail or Proton is the user's to click. Give the exact
  path; never claim you did it.
- Never paste a message body, subject or attachment name into a log, issue or chat transcript
  unless the user asks — this is somebody's mail.
- "Rejected" (a bounce the forwarding mailbox shows) and "never arrived" are different faults.
  Ask which before diagnosing.

## Status

1. `pnpm cli inbox status` — address, allow-list, whether it is on.
2. `pnpm cli inbox list` — the newest messages and their status.
3. Deployed: `pnpm --filter @rocketflare/web exec wrangler tail` while a test message is sent. The
   lines that matter: `inbox: message refused` (with the reason), `email: no handler for this
   recipient` (no plugin claimed it — the inbox is not installed in this build),
   `inbox: consumer failed`.

## Mode: explain

Say, in this order: mail reaches the Worker only for addresses Email Routing sends to it (a
dashboard rule); the inbox resolves the organisation from the local part; it accepts a message
when the **forwarding mailbox or the original sender** is on the allow-list AND SPF, DKIM or DMARC
passed; it stores the raw message in R2 and parses it in a queued job; attachments and the text
body appear on the Inbox page; consumer plugins (e.g. a receipts matcher) are then called.

## Mode: setup

1. **Domain on Cloudflare.** The receiving domain must be a Cloudflare zone. For a subdomain such
   as `app.example.com`: Dashboard → the zone → **Email** → **Email Routing** → enable → **Settings
   → Subdomains → Add**. Cloudflare writes MX + SPF; the subdomain must have no MX of its own.
2. **Route the address to the Worker.** Email Routing → **Routing rules → Create address**:
   custom address = the local part, action **Send to a Worker**, destination this app's Worker.
   Turn on **Subaddressing** in Settings so `receipts+gmail@` works. (A catch-all rule → Worker
   also works; the inbox bounces local parts no organisation owns.)
3. **Pick the address in the app.** Settings → Inbox: Address = the same local part; add the
   mailboxes that will forward (e.g. `me@gmail.com`, `me@proton.me`) to Allowed senders; leave
   Require authentication on; turn on Accept mail; Save.
4. Run **Mode: test**.

## Mode: forward-gmail

1. Gmail → Settings → **See all settings** → **Forwarding and POP/IMAP** → **Add a forwarding
   address** → the inbox address. Google sends a confirmation message there.
2. In the app, open **Inbox**: the message from `forwarding-noreply@google.com` is marked
   *confirmation* and shows the **code** (and a link). It is accepted even before the allow-list
   names anyone. Paste the code into Gmail → **Verify**.
3. Forward selectively: Gmail search for the mail you want (e.g. `from:(stripe.com) has:attachment`
   or `subject:(receipt OR invoice)`) → **Create filter** → **Forward it to** the inbox address.
   Use a `+tag` per source (`receipts+gmail@`) to see where each message came from.
4. Make sure the Gmail address itself is in **Allowed senders** — Gmail forwards with your address
   as the envelope sender, and passes SPF for gmail.com.

## Mode: forward-proton

1. Proton automatic forwarding needs a **paid** plan: Settings → **All settings** → **Forward and
   auto-reply** → **Add forwarding rule** → the inbox address, with conditions if wanted.
2. Proton asks the destination to confirm; the confirmation appears in the Inbox page (Proton
   domains are let through like Google's). Open its link.
3. Add the Proton address to **Allowed senders**. Only NEW mail is forwarded; forward older
   receipts by hand (they are accepted when you, the forwarder, are allow-listed).

## Mode: test

- Locally, with `pnpm dev` running and Settings → Inbox saved:
  `curl -X POST 'http://localhost:3001/cdn-cgi/handler/email?from=me@gmail.com&to=receipts@localhost' --data-binary @message.eml`
  (any `.eml` — save one from a mail client). Development skips the authentication check, because
  a local delivery carries no `Authentication-Results`.
- Deployed: send a real message from an allow-listed mailbox and watch `wrangler tail`.

## Mode: troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Bounce "Unknown recipient" | No organisation has that local part, or no Email Routing rule | Settings → Inbox address; check the routing rule's address |
| Bounce "Sender not allowed" | Neither the envelope sender nor `From:` is allow-listed | Add the forwarding mailbox (not the vendor) |
| Bounce "Sender could not be authenticated" | SPF, DKIM and DMARC all failed/missing | Usually a misconfigured forwarder; check the message headers in the mailbox |
| Bounce "This inbox is not accepting mail" | Accept mail is off | Settings → Inbox |
| Nothing in `wrangler tail` at all | Email Routing never sent it to the Worker | The routing rule, or the subdomain's MX records |
| Message `failed` | Parse error (corrupt MIME, R2 missing) | Inbox → Reprocess; read the error on the message |
| Message parsed but a consumer did nothing | The consumer threw — the message's error names it | Fix the consumer, then Reprocess |
