# Provider files

`SKILL.md` is the flow every provider shares — explain, operator setup, bring your own app,
connect and verify, troubleshoot. Each file here holds ONE provider's facts, named after the
provider's id (the `:provider` in `/api/hooks/connectors/<id>/callback` and the `provider` column):

| File | Provider plugin | Status |
|---|---|---|
| `m365.md` | `m365` — Microsoft 365 (Entra admin consent, app-only) | built |

## Adding a provider

A provider plugin in this repository (`google-workspace` is next) adds `providers/<id>.md` here in
the same pull request, a row in the table above, and a row in `SKILL.md`'s provider list. The file
has the same sections as `m365.md`, in the same order, so the modes in `SKILL.md` can point at them
by name:

1. **What the plugin does** — consent endpoint, callback, token shape, what is read.
2. **The permissions** — every scope, its identifier, and why the plugin needs it.
3. **Operator setup with a CLI**, then **in the console** — commands that capture a secret into a
   variable and write it to `apps/web/.dev.vars` or `wrangler secret put` without printing it.
4. **Verification / review** the vendor requires before other organisations can use the app.
5. **Bring your own app**, if the provider supports it (`supportsByo`).
6. **Connecting** — who may consent, what they see, how to undo it on the vendor's side.
7. **A tenant to test with.**
8. **Troubleshooting** — the plugin's own codes for this provider, then the vendor's error codes.
9. **Sources** — the official page behind every command, ID and label, with the month checked,
   and a "Not verified" line for anything that could not be.

Rules for writing one: every command and identifier comes from the vendor's documentation, not
memory; the plugin's codes come from the provider's source (`apps/web/src/plugins/<id>/`); a
secret is never printed; and anything outward-facing (creating an app, a secret, a deployed
secret) is marked as needing the user's yes.

A provider plugin published from ANOTHER repository cannot add a file here. It ships its own skill
(named after its id, per the plugin skills contract), and `SKILL.md` tells the agent to look for
`.claude/skills/<id>/` when `providers/<id>.md` is absent.
