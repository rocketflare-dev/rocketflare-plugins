---
name: connectors
description: Set up, connect, verify and troubleshoot organisation connections to Microsoft 365 (Office 365, Outlook, Entra ID / Azure AD) — the directory and members' calendars synced into this app by the `connectors` plugin. Use when someone asks to connect Microsoft 365 or Office 365, register the Entra app, set M365_CLIENT_ID / M365_CLIENT_SECRET, grant admin consent, sync the directory or calendars, bring their own Entra app, or when a connection shows an error, an AADSTS code, "Waiting for consent", or nothing is syncing.
argument-hint: "[explain | setup | byo | connect | status | troubleshoot <error>]"
---

# /connectors — organisation connections, set up end to end

The `connectors` plugin lets an **organisation admin** connect their whole Microsoft 365 tenant to
this app. After one admin consent, the directory (people, groups, memberships) and the Outlook
calendars of people who are **members of this app** sync every 15 minutes, app-only — nobody else
signs in to anything. It is **not login**: signing in with Microsoft is the kit's own auth and a
different app registration entirely (keep them separate). Design: `docs/CONNECTORS.md` in the kit;
the plugin's rules: `apps/web/src/plugins/connectors/CLAUDE.md`.

There are two people in this story, and you coach each one differently:

- **The operator** — whoever runs this deployment (probably the person talking to you). Registers
  ONE multi-tenant Entra app, once, and gives its id and secret to the Worker. Mode 2.
- **The customer admin** — a Global Administrator (or Privileged Role Administrator) of the
  organisation being connected. Clicks **Connect Microsoft 365** and accepts. Mode 4.

In a single-company deployment they are often the same person, in the same tenant. That is fine.

`$ARGUMENTS` picks the mode. With none: run the status check (Mode 4, step 4) and the local config
check below, then **ask** which mode they need.

**Provider detail lives in `providers/`** — `providers/m365.md` holds every command, permission ID,
portal path, error code and source link. Read it before running Mode 2, 3 or 5. This file is the
flow; that file is the facts.

| Provider id | Facts | Status |
|---|---|---|
| `m365` | `providers/m365.md` | built — directory + calendar |
| `google-workspace` | — | designed (`docs/CONNECTORS.md`), not built: say so, don't improvise setup |

A provider id with no file here comes from another repository: look for its own skill at
`.claude/skills/<id>/` and follow that for the vendor steps.

## Rules

- **Never print, echo, log or paste a client secret.** Capture it into a shell variable and hand it
  straight to the file or to `wrangler secret put` on stdin. If a secret ever appears in output,
  stop, tell the user, and rotate it (Mode 2, step 6).
- **Stop for a human yes before anything outward-facing**: creating the Entra app, creating or
  rotating a secret, writing a secret into a DEPLOYED Worker (it redeploys immediately), and
  disconnecting. Show the exact command first. Local `.dev.vars` edits need a yes too — they
  overwrite a value.
- **`az ad app credential reset` WITHOUT `--append` deletes every existing secret on the app** and
  breaks every environment using one. Always pass `--append`.
- **Do not grant admin consent in the operator's own tenant** from the portal or with
  `az ad app permission admin-consent` unless that tenant is also a customer. Consent is what
  Mode 4 does, per organisation, through this app's own flow — which is also how the installation
  learns its tenant id.
- **Anything you cannot verify, say so.** Microsoft renames portal labels often; when a label does
  not match, describe what to look for rather than guessing, and point at the source link in
  `providers/m365.md`.
- End every turn with `AskUserQuestion`, offering the next sensible mode.

## Local config check (read-only, run first)

```bash
pnpm plugin list                       # expect lines for connectors and m365
grep -E '^(APP_URL|M365_CLIENT_ID|M365_CLIENT_SECRET|OAUTH_ENCRYPTION_KEY)=' apps/web/.dev.vars | sed -E 's/=.+/=<set>/'
```

Expect `APP_URL=<set>` (locally `http://localhost:3000`), and `OAUTH_ENCRYPTION_KEY=<set>` — the
consent state is signed and a BYO secret sealed with it; without it `POST /api/connectors/installations`
answers 503 `encryption_key_missing`. `M365_*` unset is normal before Mode 2. The `sed` masks the
values: never print `.dev.vars` raw.

- `m365` missing from `pnpm plugin list` → it is not installed; run `/rf-plugin add
  https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/connectors`, then
  `--subdir plugins/m365` (connectors first — m365 requires it).
- The Connections tab then says "No provider is installed" until `m365` is there.

## Mode 1 — explain (no changes)

Tell them, briefly:

- **What is read**: every user and group in the directory (name, email, job title, enabled,
  group memberships), and the calendar events (−30 to +90 days, UTC) of each person whose
  directory email matches a member of this app. People who never joined the app are directory
  rows only; their calendars are not read. Guests (`#EXT#` accounts) are never matched.
- **What is granted**: three Microsoft Graph **application** permissions — `User.Read.All`,
  `Group.Read.All`, `Calendars.Read`. `Calendars.Read` as an application permission can read
  every mailbox's calendar in that tenant; the plugin *chooses* to read only members'. If the
  customer needs that enforced by Microsoft, see "Scoping calendar access" in `providers/m365.md`.
- **Who sees what inside this app**: members see only their own events (My calendar); owners and
  admins see all synced calendars and the directory (Settings → Connections); `support` sees
  status only.
- **What it is not (yet)**: no mail, no files, no webhooks (polling every 15 minutes), no Google
  Workspace, no per-user "connect my own account" — all designed in `docs/CONNECTORS.md`, not built.
- **Disconnecting** deletes every synced row here; revoking Microsoft's side is a separate step the
  customer admin does in Entra (Mode 4, step 6).

## Mode 2 — operator setup (drive it; the human signs in)

Goal: one multi-tenant Entra app registration whose id and secret this Worker holds as
`M365_CLIENT_ID` / `M365_CLIENT_SECRET`, with a redirect URI per environment.
**Follow `providers/m365.md` → "Operator setup with the Azure CLI"** step by step. The shape:

1. **Prerequisites** — an Entra (work or school) tenant to own the app, an account that can
   register apps there, and the Azure CLI (`az version`; install per OS from `providers/m365.md`).
   No CLI and they would rather click? Use the portal steps in the same file instead, and still do
   steps 5–7 here.
2. **Sign in — HUMAN step.** Ask them to run, in their own terminal (it opens a browser):
   `! az login --allow-no-subscriptions --tenant <tenant-id-or-domain>`. Then you confirm with
   `az account show --query "{tenant:tenantId, user:user.name}" -o table`.
3. **Collect the redirect URIs** — one per environment, each `<APP_URL>/api/hooks/connectors/m365/callback`:
   ```bash
   grep '^APP_URL=' apps/web/.dev.vars                                   # local, e.g. http://localhost:3000
   grep '^APP_URL' apps/web/wrangler.toml apps/web/wrangler.staging.toml # production, staging
   ```
   Show the list and **ask** which environments to register now (they can add more later).
4. **Create the app — sign-off first.** Show the `az ad app create …` and `az ad app permission
   add …` commands from `providers/m365.md` with the real values, get a yes, run them, and keep the
   `appId` in a variable. Re-running? Look it up by name first (the file shows how) — never create a
   second app with the same name by accident.
5. **Create a secret and store it without printing it — sign-off first.** Local: the
   `.dev.vars` writer in `providers/m365.md`. Deployed: pipe it to `wrangler secret put` for that
   environment (redeploys the Worker immediately — say so before running). Set `M365_CLIENT_ID`
   the same way. Then restart `pnpm dev` (`pnpm dev:stop && pnpm dev`) so the Worker reads them.
6. **Diary the expiry.** The CLI default is 1 year (portal maximum 24 months; Microsoft recommends
   under 12). Tell them the date and that expiry shows up as `AADSTS7000222` and an `error`
   installation. Rotation = step 5 again with `--append`, then remove the old secret.
7. **Verify** — `GET /api/connectors/providers` now reports `operatorConfigured: true` (the
   Connections tab stops saying the app is not set up; depending on the plugin version, an operator
   may also see these same steps in a deployment-setup section there). Hand over to Mode 4.

**Before selling to other organisations:** publisher verification (a blue "verified" badge on the
consent screen, and the only way some tenants' users can consent to a newer multi-tenant app).
It needs a Microsoft AI Cloud Partner Program account and a DNS-verified domain; it is free and a
human task. Coach it from `providers/m365.md` → "Publisher verification"; do not attempt it.

**Known limitation to state plainly:** the plugin authenticates with a client secret. Microsoft
now recommends certificates for production apps; certificate support is a planned follow-up in
the `m365` plugin, not something to configure today.

## Mode 3 — bring your own app (a customer registers theirs)

For an organisation that will not consent to the operator's app (regulated, or policy blocks
third-party apps). They register their own **multi-tenant** Entra app in their own tenant with the
same redirect URI and the same three application permissions — `providers/m365.md` → "Bring your
own app" has the steps for THEIR admin — then in Settings → Connections tick **"Use our
organisation's own registered app"**, paste the client id and secret, and press Connect. The
secret is sealed with `OAUTH_ENCRYPTION_KEY` and never shown again; to change it, they re-enter
it. It must be multi-tenant because consent goes through `/organizations` (a single-tenant app
fails there — see Mode 5). Their secret's expiry is THEIR diary entry.

## Mode 4 — connect and verify

1. **Who** — the customer admin must be a **Global Administrator** or **Privileged Role
   Administrator** of their Microsoft 365 tenant. Application Administrator and Cloud Application
   Administrator **cannot** consent to Microsoft Graph application permissions. In this app they
   need the owner or admin role (connecting is `manage Connector`).
2. **Connect** — Settings → Connections → **Connect Microsoft 365**. Microsoft shows the three
   permissions; they accept. They land back on Settings → Connections with a "Connected. The first
   sync has started." toast. A red toast names a callback code — Mode 5 table.
   A link that sits for more than 30 minutes before consent expires (`invalid_state`); press
   Connect again.
3. **First sync** — the directory syncs immediately; calendars follow once people are matched to
   members. Locally the queue runs inside `pnpm dev`, so it is seconds; to not wait for the next
   quarter hour: `pnpm cli connectors sync`.
4. **Check** (needs `pnpm cli login --server http://localhost:3001` once, as an owner/admin):
   ```bash
   pnpm cli connectors status          # deployed: rocketflare connectors status
   pnpm cli connectors status --json   # the same, parseable
   ```
   Expect `m365: active — <tenant>` and counts `people N (M members) · groups … · calendars … ·
   events …`, then a table of `users`, `groups`, `calendar` cursors with **Last synced** filled and
   **Failing 0**. `calendars 0` with `M members > 0` right after connecting is normal until the next
   pass; `M members 0` means nobody's email matched — Mode 5.
5. **See it** — Settings → Connections shows the same counts; **My calendar** (nav) shows the
   signed-in member's own events.
6. **Disconnect** — Settings → Connections → Disconnect deletes every synced row here (sign-off
   first; there is no undo). Then the customer admin removes the app on Microsoft's side:
   Entra admin center → Entra ID → Enterprise apps → the app → Properties → Delete (restorable for
   30 days). Until they do, the app keeps its consent in their tenant.

**No test tenant?** `providers/m365.md` → "A tenant to test with" — the Microsoft 365 Developer
Program sandbox is no longer open to everyone (it needs a Visual Studio subscription, a partner
program tier or a support contract); the fallback is a 30-day business trial.

## Mode 5 — troubleshoot

Collect the evidence first, then match it:

```bash
pnpm cli connectors status          # installation status, lastError, per-resource Failing + errors
pnpm dev:status                     # is the dev server even up
```

Plus the red toast / the `connectError=` code in the Settings URL, and the Worker log lines
containing `connectors`. Then:

- **Callback codes** (`connectError=`), **installation errors** (`lastError`) and **AADSTS codes**
  — the tables in `providers/m365.md` → "Troubleshooting". Each row says what it means, who fixes
  it, and the fix.
- **`error` installation** — after fixing the cause, **Sync now** (or `pnpm cli connectors sync`)
  puts it back to `active` and retries; the next token request is the real test. Revoked consent or
  missing permissions → **Re-grant consent** instead.
- **One calendar failing, the rest fine** — that mailbox has no Exchange Online licence, is on-premises,
  or is excluded by an Exchange scope; it never takes the installation down.
- **Throttling** is handled: a 429/503/504 waits for Microsoft's `Retry-After` and is not counted
  as a failure. Persistent throttling on one mailbox is Outlook's per-mailbox limit.
- **Nothing happens on the 15-minute tick in a deployed environment** — the `*/15 * * * *` cron
  must be in both tomls: `pnpm provision cloudflare <env>` writes it (that command is `/rf-provision`
  territory — the user runs it). Locally, fire it by hand:
  `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=*%2F15+*+*+*+*"`.

If a code is not in the tables, look it up in Microsoft's error reference (link in
`providers/m365.md`), report what it says and that the table lacks it — do not improvise a fix.

## Hand back

End with `AskUserQuestion`. After Mode 2: **connect now** (Mode 4), **add another environment's
redirect URI**, or **stop**. After Mode 4: **open My calendar**, **explain what was synced**
(Mode 1), or **stop**. After Mode 5: **retry the sync**, **re-grant consent**, or **escalate**
with the collected evidence.
