# web-knowledge plugin

Web search for agents and chat, on each organisation's own search API key. An admin picks a
provider in **Settings → Web search**, saves a key, tests it and turns it on. From then on, that
tenant's agent runs and chat turns carry two more tools, `web_search` and `fetch_page`. No other
tenant gets them. Requires kit ≥ 0.9.0 because `agentTools` has to be async and `sealSecret` has to
exist.

| Where | What |
|---|---|
| `packages/shared/src/plugins/web-knowledge/index.ts` | Provider list and info (`WEB_SEARCH_PROVIDER_INFO`, which the page reads directly), settings contracts, `webKnowledgeShared` (subject `WebSearchConfig`) |
| `index.ts` | Server entry. It has one mount and grants (admin-level `manage`; member and support `read`). `agentTools` reads the tenant's row and returns `[]` unless the row is enabled **and** has a key |
| `db/schema/web-search-settings.ts` | `web_search_settings`: one row per tenant (unique `tenant_id`), `api_key_enc` = `sealSecret` output, RLS |
| `api/settings.ts` | The only reader and writer of the row. `nextSettings` holds the update rules as a pure function: an omitted key is kept, `null` clears it, and a provider change with no new key clears it |
| `api/routes.ts` | `GET/PUT /api/web-knowledge/settings` and `POST /settings/test`. The test route always answers 200 with a verdict |
| `services/providers/` | One adapter per provider (Tavily, Brave, Exa, Serper, Firecrawl), normalised to `SearchHit`. `providerJson` maps 401/403 → `key_rejected`, 429 → `rate_limited`, a timeout → `timeout`, and anything else → `provider_error` |
| `services/fetch-page.ts` | `guardUrl` (http/https only, default ports, no IP literals, no localhost or private suffixes) and a direct fetch with manual redirects that runs the guard again on every hop, a 2 MB cap, and `AI.toMarkdown` with a tag-strip fallback |
| `tools/` | `web_search` and `fetch_page`, each via `defineTool`. Failures come back as `{ error, message, hint }` (`tools/errors.ts`). `fetch_page` windows by the caller's `maxDocumentChars` and marks page text as untrusted in `note` |
| `ui/` | One settings tab, lazy page `pages/WebSearchSettings.tsx`, in its own `Suspense` |
| `apps/cli/src/plugins/web-knowledge/` | `rocketflare web-knowledge status [--json]`. Read-only by design: keys don't belong in shell history |

## Rules

- **The key never leaves the server.** Routes answer `hasCredential`. The activity row records
  `key: keep|clear|set`, never the value. The key is opened only inside a tool handler or the test
  route, at the moment of the outbound call, never in the `agentTools` builder.
- **Every adapter takes `fetch` from its call**, so tests inject one and nothing reaches a provider.
  In production, pass `(input, init) => fetch(input, init)`: an unbound `fetch` called as a method
  throws "Illegal invocation" on Workers.
- **Adding a provider** takes three steps:
  1. Add it to `WEB_SEARCH_PROVIDERS` and `WEB_SEARCH_PROVIDER_INFO`.
  2. Write an adapter in `services/providers/`. `SEARCH_ADAPTERS` is a `Record` over the provider
     type, so a missing adapter is a compile error.
  3. Add a case to `tests/config/providers.test.ts`, including the status-mapping loop.

  `provider` is stored as text, so a new provider needs no migration.

## Known gaps

- `guardUrl` checks names, not addresses. A public hostname that resolves to a private address
  gets through, because a Worker has no DNS API. On Cloudflare's network a Worker can't reach
  private space anyway; under `wrangler dev` it can.
- There's no platform-wide fallback key. Each organisation brings its own.
- There are no quotas and no usage ledger. The provider bills the organisation's key.
- Without provider extraction (Brave, Serper), `fetch_page` can't read JavaScript-rendered pages.
- The settings row is read on every chat turn and agent run (one indexed lookup) to decide whether
  to offer the tools.
