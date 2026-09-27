# connectors

> Organisation-level connections to your customers' workplace tools: an admin connects the whole
> organisation once, and the directory and members' calendars sync into your app.

This is not "Sign in with Microsoft" — the kit already does that. A **connection** is a different
grant: an organisation admin consents once for everybody, and the app reads the directory and
calendars with app-only access on a schedule. The design (usage models, phases, security) is in the
kit's [`docs/CONNECTORS.md`](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONNECTORS.md).

`connectors` is provider-neutral: it owns every table, route, cursor and schedule, and a provider
plugin supplies the vendor conversation. Today that is [`m365`](../m365/) (Microsoft 365);
Google Workspace is next. **Install a provider too** — on its own, this plugin connects nothing.

## What it adds

| Area | What you get |
|---|---|
| UI | **Settings → Connections** (connect, consent, sync status, sync now, disconnect) and **My calendar** at `/calendar` |
| Sync | Directory people, groups and memberships, and the calendars of directory people who are members of your app (matched by email), via delta queries — every 15 minutes by the `*/15 * * * *` cron, or on demand. Cursors resume after every page and a lost cursor restarts a full pass |
| API | `/api/connectors` (providers, installations, sync, directory, events) and the public consent callback at `/api/hooks/connectors/<provider>/callback`, which trusts only a signed state |
| Data | `connectors_installations`, `connectors_connections`, `connectors_sync_cursors`, `connectors_directory_users`, `connectors_directory_groups`, `connectors_group_members`, `connectors_calendar_events` — all tenant-scoped with row-level security; disconnecting deletes everything synced |
| CLI | `rocketflare connectors status` and `rocketflare connectors sync [--provider] [--resource]` |
| Agent skill | `connectors` — explains connections, drives the operator's app registration end to end, helps an organisation bring its own app, verifies a connection and troubleshoots errors |
| Feature flag | `connectors` (on by default) |

## Requirements

- Rocketflare kit **0.13.0** or later.
- At least one provider plugin (`m365`).
- `OAUTH_ENCRYPTION_KEY` set in the app — tokens and bring-your-own secrets are sealed with it.
- The provider's own setup: for Microsoft 365, an app registered in Entra ID (the `connectors`
  skill does it with the Azure CLI).

## Install

`connectors` first, then the provider; generate a migration after each:

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.4.0 --subdir plugins/connectors --apply
pnpm db:generate --name plugin-connectors-3.4.0
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.4.0 --subdir plugins/m365 --apply
pnpm db:migrate
```

Drop `--apply` to read each plan first. The install also adds the `*/15 * * * *` cron to both
wrangler tomls (`pnpm provision cloudflare <env>` writes it).

## First run

1. Ask your coding agent to **set up Microsoft 365 connections** — the `connectors` skill registers
   the app, sets `M365_CLIENT_ID` / `M365_CLIENT_SECRET` without ever printing the secret, and
   checks your redirect URI. Or follow the steps in [`m365`](../m365/).
2. As an organisation admin, open **Settings → Connections** and press **Connect Microsoft 365**.
   A Microsoft Global Administrator (or Privileged Role Administrator) consents.
3. The directory syncs first; calendars follow for people who are members of your app.
   `rocketflare connectors status` shows every cursor; **My calendar** shows your events.

## Who sees what

- **Platform operator** (global admin): the deployment-setup panel with the app-registration steps.
- **Organisation owner/admin**: connect, consent, sync, disconnect — and every synced calendar in
  their organisation. On a deployment with no operator app, they are told to ask the operator or to
  bring their own app.
- **Member**: their own calendar, and connection status only.
- Tokens and secrets are sealed at rest and never returned by the API.

## Known gaps (phase 1)

- Microsoft 365 only; Google Workspace is designed but not built.
- Polling every 15 minutes; webhooks (phase 2) are not built.
- Directory and calendar only; mail and files (phase 3) and per-user connections (phase 4) are not
  built.
- Admins can read every synced calendar in their organisation; there is no per-person opt-out.
- The directory is matched to your app's members by email; it does not create users or groups.

## More

- [`CLAUDE.md`](apps/web/src/plugins/connectors/CLAUDE.md) — the plugin's reference.
- [`skills/connectors/`](skills/connectors/) — the setup skill and its provider notes.
- [Upgrade notes](docs/upgrades/) — one per release.
- The kit's [`docs/CONNECTORS.md`](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONNECTORS.md)
  (design, D34).
