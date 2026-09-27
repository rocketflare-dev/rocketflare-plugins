---
version: unreleased
previous: 3.2.0
date: null
breaking: false
migrations: []
areas: [shared, api, ui, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Connectors now ships a `connectors` Claude Code skill that drives Microsoft 365 setup end to end, and Settings → Connections shows each audience only the steps it can act on.

- New skill `connectors` (installed to `.claude/skills/connectors/`): explain; operator setup that drives the Azure CLI (app registration, verified Graph permission GUIDs, the redirect URI, a client secret written to `.dev.vars` or `pnpm provision secrets` without ever being printed); bring-your-own app; connect and verify; and troubleshooting (AADSTS codes, installation and cursor errors, throttling). Provider detail is in `providers/m365.md`.
- `GET /api/connectors/providers` returns `operatorSteps` only to a global admin, and adds `redirectUri` (this deployment's consent callback) and `viewer.isOperator`. `operatorConfigured` is still a boolean, never a credential.
- Settings → Connections: a tenant admin on a deployment without the operator app sees "ask your platform operator", plus the bring-your-own-app form with this deployment's redirect URI. A global admin gets a deployment-setup panel that points at the skill. Members see status only.
- Fix: "Re-grant consent" on a bring-your-own-app installation no longer switches it to the operator app; it reopens the credentials form.
- `minKit` rises to 0.13.0, the first kit that installs plugin skills.

## How to apply

1. Upgrade the kit to 0.13.0 or later first (`pnpm kit:upgrade`).
2. Run `pnpm plugin upgrade connectors --apply`. It updates the plugin's files and installs `.claude/skills/connectors/`.

## Conflicts to expect

- `apps/web/src/plugins/connectors/ui/pages/ConnectionsSettings.tsx` → rewritten per audience → take the plugin's version unless you customised the tab.

## Verify

1. `pnpm plugin check` reports `connectors` checks out, and `.claude/skills/connectors/SKILL.md` exists.
2. As a tenant admin on a deployment without `M365_CLIENT_ID`, Settings → Connections says to ask the platform operator and shows no Entra registration steps.
