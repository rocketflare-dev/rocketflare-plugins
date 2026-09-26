# m365 plugin

Microsoft 365 as a `connectors` provider (D34, phase 1): Entra admin consent, app-only client
credentials, `users/delta` + `groups/delta` (with `members@delta`) and per-mailbox
`calendarView/delta`. Contributes ONE thing — `m365Provider`, through `extensions` — and requires the
`connectors` plugin, which owns every route, table, job and screen. No schema, UI or CLI here.

| Where | What |
|---|---|
| `packages/shared/src/plugins/m365/index.ts` | `m365Shared`: id and the two optional secrets `M365_CLIENT_ID`, `M365_CLIENT_SECRET` (the operator's multi-tenant Entra app) |
| `index.ts` | Server entry: `extensions: connectorExtensions({ providers: [m365Provider] })`, the builder imported from `connectors`' SHARED half (module scope — see the note there) |
| `provider.ts` | The provider: consent URL (`/organizations/v2.0/adminconsent`), `completeConsent` (`admin_consent=True`, tenant GUID), `mintToken`, the directory and calendar sources, and the Graph → item mappers |
| `graph.ts` | `graphGet` (Bearer, `x-ms-throttle-priority: low`, host pinned to `graph.microsoft.com`) and `clientCredentialsToken`, with Microsoft's failures mapped: 429/503/504 → `RetryLaterError`; 410/`syncStateNotFound` → `CursorExpiredError`; refused app (AADSTS700016, 7000215, 7000222, 7000229, 65001, 90002) or a directory 401/403 → `ConnectorAuthError`; a single mailbox's 403/404 → an ordinary failure on that cursor |
| `tests/config/provider.test.ts` | Everything above with a fake `fetch` |
| `tests/api/m365.test.ts` | Offered by the registry; 503 without operator secrets; a consent URL whose state completes on the public callback |

## Rules

- **Only fields Graph sent become item fields.** Incremental delta rounds are partial; an absent
  key is "unchanged" (`has()` in `provider.ts`), never null.
- **A guest UPN (`#EXT#`) is not an email address** — matching on it finds nobody.
- **Calendar times are UTC**: every calendar request sends `Prefer: outlook.timezone="UTC"`.
- **Never send the app token anywhere but `graph.microsoft.com`** (`graphUrl` refuses).

## Known gaps

- Client secret only; certificate (JWT client assertion, PS256) is a follow-up — secrets expire
  after at most 24 months.
- Consent always goes through `/organizations`, so a BYO app must be registered multi-tenant.
- No Exchange RBAC-for-Applications scoping helper yet (the way to limit `Calendars.Read`, and later
  `Mail.Read`, to a set of mailboxes).
- Change notifications (Graph subscriptions) are phase 2; this polls through `connectors`' cron.
