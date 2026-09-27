# m365

> Microsoft 365 for [`connectors`](../connectors/): an organisation admin consents once, and your
> app syncs their Entra ID directory and members' Outlook calendars, app-only.

This plugin is the vendor half of a connection. It has no tables, routes or pages of its own —
everything you see belongs to `connectors`, which it requires.

## What it adds

| Area | What you get |
|---|---|
| Consent | Entra admin consent through `/organizations/v2.0/adminconsent`; the organisation's tenant id comes back on the callback |
| Tokens | Client-credentials tokens per organisation, cached sealed and re-minted before expiry; a bearer token is only ever sent to `graph.microsoft.com` |
| Directory | `users/delta` and `groups/delta` with memberships |
| Calendars | `calendarView/delta` per member mailbox, over a rolling window from 30 days back to 90 days ahead |
| Resilience | Honours `Retry-After` on 429/503/504, sends `x-ms-throttle-priority: low`, restarts a full pass on `410` / `syncStateNotFound`, and marks the installation in error when consent is revoked or the secret expires |

## Requirements

- Rocketflare kit **0.12.0** or later, and the [`connectors`](../connectors/) plugin (kit 0.13.0).
- An app registered in Microsoft Entra ID as **multitenant**, with the web redirect URI
  `<APP_URL>/api/hooks/connectors/m365/callback` for each environment and three Microsoft Graph
  **application** permissions: `User.Read.All`, `Group.Read.All`, `Calendars.Read`.
- Secrets `M365_CLIENT_ID` and `M365_CLIENT_SECRET` (optional: without them, an organisation can
  still bring its own app from Settings → Connections).

## Install

After `connectors`:

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.4.1 --subdir plugins/m365 --apply
```

## Set it up

**With your coding agent** (recommended): ask it to *set up Microsoft 365 connections*. The
`connectors` skill checks your config, drives the Azure CLI to register the app and add the
permissions, writes the client secret to `.dev.vars` or your deployed secrets without printing it,
and reminds you when the secret expires (24 months at most).

**By hand**, in the Entra admin center:

1. App registrations → New registration → *Accounts in any organizational directory (multitenant)*.
2. Authentication → add a **Web** redirect URI: `<APP_URL>/api/hooks/connectors/m365/callback`
   (locally `http://localhost:3000/api/hooks/connectors/m365/callback`).
3. API permissions → Microsoft Graph → **Application permissions** → `User.Read.All`,
   `Group.Read.All`, `Calendars.Read`.
4. Certificates & secrets → New client secret; copy the value (shown once).
5. Set `M365_CLIENT_ID` and `M365_CLIENT_SECRET` — `apps/web/.dev.vars` locally,
   `pnpm provision secrets <env>` when deployed.
6. Before offering it to other organisations, complete **publisher verification** (Branding &
   properties) — unverified multitenant apps show a warning at consent.

Then an admin of each customer organisation presses **Connect Microsoft 365** in Settings →
Connections and a Global Administrator (or Privileged Role Administrator) consents.

## Troubleshooting

Consent and token errors arrive as `AADSTS` codes — for example 50011 (redirect URI mismatch),
65001 (consent not granted), 7000215 (wrong secret) and 7000222 (expired secret). The `connectors`
skill has the full table and the fix for each; ask your agent to troubleshoot the connection.
To disconnect completely, press **Disconnect** in Settings → Connections **and** remove the app
under Entra admin center → Enterprise applications.

## Known gaps

- Client secret only; certificate credentials are not supported yet.
- No webhooks, mail or files yet (see `connectors`' roadmap).
- Mailbox scoping with Exchange RBAC for Applications is possible on Microsoft's side but untested
  with this plugin.

## More

- [`CLAUDE.md`](apps/web/src/plugins/m365/CLAUDE.md) — the provider's reference.
- The `connectors` skill's [Microsoft 365 notes](../connectors/skills/connectors/providers/m365.md),
  with sources for every step.
- [Upgrade notes](docs/upgrades/) — one per release.
