# freeagent plugin — rules for this directory

An organisation's FreeAgent books: OAuth (`api/routes.ts` connect → FreeAgent → `api/hooks.ts`
callback) → sealed tokens on `freeagent_connections` → `freeagent.sync` (cron `*/30`, "Sync now",
the callback) → `services/sync.ts` → the `freeagent_*` mirror → agent tools, the page, cubes, and
every `freeagent:sync-listeners` extension.

- **Every FreeAgent call goes through `FreeAgentClient`** (`services/client.ts`): it sends
  `X-Api-Version: 2026-09-01`, refreshes tokens, waits out 429s (bounded), follows `Link`
  pagination and refuses any URL off the connection's API host. Never `fetch` FreeAgent directly.
- **`fetch` is injected.** Services take `deps` (default `freeagentHttp`); tests pass a fake, and
  route tests swap `freeagentHttp.fetch` for one test. No test reaches FreeAgent.
- **Tokens are sealed** (`sealSecret`) in `*_enc` columns, never returned, never logged, nor are
  approval codes. Log a `FreeAgentError.code`, not a body.
- **`invalid_grant` → `needs_reconnect`**, recorded on the row; the cron skips it, tools vanish.
- **Money is a decimal string** end to end (`numeric` columns, zod `decimalStringSchema`). Never
  `Number()` an amount.
- **Mirror rows are keyed `(tenant_id, url)`** and written only through `services/mirror.ts`
  (`upsertMirror`), by the sync and by every write — a write updates the row it touched.
- **The one cross-tenant read** is the cron fan-out in `api/scheduled.ts` (tenant ids only). It
  needs no `unscopedAllowlist` entry: the kit scan sees the `tenantId` it selects.
- **Cubes are plain data** contributed under `analytics:*` keys (`cubes/index.ts`): no import of
  analytics or drizzle-cube, inert without it. A new cube needs an isolation case beside it.
- **Listeners** (`FreeAgentSyncListener`) are called after a successful sync; a throw is logged and
  does not fail the sync. They must be quick and idempotent.
