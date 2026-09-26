# connectors plugin

An organisation ADMIN connects the organisation's Microsoft 365 / Google Workspace — not one
person's login (that is the kit's arctic providers) — and the app syncs the directory and its
members' calendars (D34, kit `docs/CONNECTORS.md`). Provider-neutral: a provider plugin (`m365`;
`google-workspace` next) contributes one `ConnectorProvider` through `extensions`. This plugin owns
every row, route, cursor, claim and schedule; a provider owns only the vendor conversation and never
touches the database. Requires kit ≥ 0.12.0 (public mounts, `signState`, `ctx.features(tenantId)`).

| Where | What |
|---|---|
| `packages/shared/src/plugins/connectors/index.ts` | Contracts, `connectors.sync` job, flag `connectors` (default on), subject `Connector`, and `connectorExtensions` + `CONNECTOR_EXTENSION_KEYS` — in the SHARED half so a provider can call it at module scope without closing the server-barrel cycle |
| `index.ts` | Server entry: `/api/connectors` (gated on the flag), public `/api/hooks/connectors`, the job, the `*/15` cron, grants (owner/admin `manage`, support `read`, members none — they read their own events without a subject). Re-exports the provider contract and errors |
| `providers.ts` | `ConnectorProvider` and what it is handed/returns (`SourceCtx`, `SyncPage`, items), the errors that steer the engine (`CursorExpiredError`, `RetryLaterError`, `ConnectorAuthError`, `ConsentError`), the zod-narrowed registry, `setConnectorProvidersForTests` |
| `db/schema/` | `installations` (admin act, sealed BYO secret) → `connections` (organisation `'*'`, one per mailbox, later per user; sealed token cache) → `sync_cursors` (opaque cursor, generation, DB claim); `directory_users/groups`, `group_members`; `calendar_events` (owner-visible). Everything cascades from the installation |
| `services/sync.ts` | The engine: load → claim → (full pass?) → page → apply → save cursor after EVERY page → final: sweep (full passes only) + reconcile → release / continue. Failure → instruction mapping is in its header |
| `services/apply.ts` | Idempotent upserts. Absent item fields mean UNCHANGED (partial deltas), grouped by shape so a page is still one statement per shape; repeats within a page are merged |
| `services/reconcile.ts` | Matches directory people to members (lower-cased email); a mailbox connection exists exactly while its person is live, enabled and a member |
| `services/tokens.ts` | Sealed token cache on the connection row, re-minted 5 min before expiry; records granted scopes |
| `services/events.ts` | The ONE place calendar visibility is decided: owner, or `manage Connector` |
| `api/routes.ts` · `api/hooks.ts` · `api/consent.ts` · `api/scheduled.ts` | Authed routes; the public consent callback (trusts only the signed state); state + redirect helpers; the cron |
| `ui/` | Settings → Connections (`pages/ConnectionsSettings.tsx`), My calendar (`pages/MyCalendarPage.tsx`, route `/calendar`) |
| `apps/cli/src/plugins/connectors/` | `rocketflare connectors status | sync [--provider] [--resource]` |

## Rules

- **Only the signed state names a tenant on the public mount.** Parse it with zod after
  `verifyState`; every failure redirects to Settings with a code, never a stack.
- **Calendar data is per person inside a tenant.** Every events query carries `tenant_id` AND the
  owner predicate unless the reader has `manage Connector`. Never add a read path elsewhere.
- **Only members are calendared.** A directory person who never joined the app is synced as a
  directory row and nothing more.
- **Save the cursor after every page**, and only a FULL pass may sweep.
- **A bearer token is only sent to the provider's own API host** — the provider's job, but check
  it in review.
- **Adding a provider** is a provider plugin, not an edit here: implement `ConnectorProvider`,
  contribute it with `connectorExtensions` from the shared entry, `requires.plugins: ["connectors"]`.
  A new RESOURCE (mail, files) is an edit here: the resource list, an `apply*`, a branch in the
  engine, a source on the contract.

## Known gaps

- Phase 1 is polling only (every 15 minutes). Webhooks (Graph subscriptions, Google channels) are
  phase 2 and will live on the public mount beside the callback.
- No per-user delegated connections yet (phase 4) — the columns exist (`owner_type = 'user'`,
  `refresh_token_enc`), the flow does not.
- A BYO Microsoft app must be registered multi-tenant: consent goes through `/organizations`.
- Directory rows are soft-deleted and never purged while the installation lives.
- Admins can read every synced calendar in their organisation; there is no per-person opt-out.
- The cron reconciles every active installation every tick (a few indexed statements each).
