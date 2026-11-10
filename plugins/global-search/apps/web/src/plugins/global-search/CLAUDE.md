# global-search

One ⌘K palette and `/search/all` over every registered search provider. The user-facing story is
`README.md` at the plugin's root; this file is for changing the code.

## Where things are

| Path | What |
|---|---|
| `packages/shared/src/plugins/global-search/index.ts` | The provider contract (`SearchProviderOf`, `SearchProviderKind`, `SearchProviderHit`, `SearchProviderInput`, `SearchProviderCtxOf`), its zod schemas, the wire contracts, the constants (`PROVIDER_TIMEOUT_MS`, `RRF_K`, `DENSE_ONLY_WEIGHT`, `RERANK_*`) |
| `…/search-text.ts` | `flattenMarkdown`, `cleanSnippet(snippet, title, labels?)`, shared by the UI and the re-ranker |
| `types.ts` | `SearchProviderCtx` / `SearchProvider` bound to the kit's types |
| `services/registry.ts` | `buildRegistry` (pure validation) and `installedProviders()` over `extensions('global-search.providers')` |
| `services/search.ts` | `fanOut` (parallel, per-provider budget, `degraded`), `fuse` (RRF on `href`), `globalSearch`, `usableProviders` (guards) |
| `services/rerank.ts` | The `/rerank` client (Cohere / Voyage / Fireworks dialects) and `applyRerank` (never throws) |
| `services/settings.ts` | The settings row, the update rules, `resolveReranker` (opens the key at the moment of use) |
| `providers/documents.ts`, `providers/nav.ts` | The two built-in providers, registered through `extensions` like anyone else's |
| `api/router.ts` | `/api/global-search` |
| `ui/` | Header trigger (lazy), palette (lazy), `/search/all`, Settings → Search, `searchModel.ts` (pure) |

## Rules

- **The provider contract is published and other plugins build against it structurally** (they
  never import this plugin). Changes are additive only: a new OPTIONAL field on a provider, a hit or
  the input. Never rename or remove a field, tighten a schema an existing provider passes, or change
  what a field means.
- **Tenant isolation is each provider's.** The fan-out hands a provider the reader's `scope`,
  `tenantId` and ability and nothing else to query with; the built-in documents provider reads only
  through `searchKnowledge(ctx, …)` with no `platformSources`. A new built-in provider adds a
  two-tenant case to `tests/api/global-search.test.ts`.
- **Nothing a provider does fails the request.** A timeout, a throw or an unparseable answer is a
  `degraded` entry. A bad REGISTRATION is different: it throws `InvalidSearchProviderError` (loud,
  by design), and `tests/config/installed-providers.test.ts` catches it in the gate.
- **`href` is in-app** (`isInAppHref`): it is both the link the palette navigates to and the fusion
  key. Recent items re-check it on read, so a tampered localStorage entry never becomes an
  off-site link.
- **The re-ranker key** is sealed with `sealSecret`, opened only in `resolveReranker`, and never
  returned (`hasCredential`). A URL change without a new key clears it.
- **Module order:** `services/rerank.ts` and `providers/documents.ts` import `@/plugins/api` at
  runtime, so a test that imports them first must `import '@/plugins/api/peers'` before anything
  else (see the two config tests).

## Tests

- `tests/api/global-search.test.ts`: real Postgres, real mount, `@/plugins/api/peers` mocked to add
  third-party providers (`// @vitest-isolate`). Tenant isolation, visibility, guards, timeouts,
  invalid registrations, an unreachable re-ranker, the settings routes.
- `tests/config/`: fusion, fan-out, registry, nav, the re-ranker client, the UI model, the
  installed set.
- `tests/ui/`: the palette, `/search/all`, Settings → Search.
