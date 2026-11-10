---
version: unreleased
previous: null
date: null
breaking: false
migrations:
  - global_search_settings — one row per tenant (unique tenant_id): rerank_enabled, rerank_base_url, rerank_model, sealed rerank_api_key_enc, updated_by_user_id; RLS policy
areas: [api, ui, db]
touches_surfaces: []
requires_surfaces: [feature-knowledge]
manual: false
---

## What changed

First release of `global-search`: a ⌘K palette in the header and a `/search/all` page over every registered search provider, fused with RRF and optionally re-ranked per organisation.

- `GET /api/global-search?q&kinds&limit` calls every provider the reader may use in parallel, each within 1.5 seconds and its own `AbortSignal`, and answers `{ items, semantic, degraded, ranking }`. A provider that times out, throws or answers something that does not parse is listed in `degraded` and never fails the request.
- Results are fused by Reciprocal Rank Fusion (k = 60) on `href`, with a weight per hit (0.5 for a dense-only hit). The top 50 are re-ranked when the organisation has a re-ranker switched on; a timeout or failure keeps the fused order and `ranking.rerank.reason` says why.
- Any plugin registers providers under `ServerPlugin.extensions['global-search.providers']` without importing this plugin. Registrations are validated with zod; an invalid one, an id outside the registering plugin's namespace, a duplicate id or a kind declared twice is refused with an error naming the contributing plugins.
- Built-in providers: `global-search:documents` (tenant documents through `searchKnowledge`, best passage per document, deep-linked as the kit's `/search` links a passage; guarded by `read Document`) and `global-search:nav` (the kit's core pages by name, each behind its own guard).
- `GET /api/global-search/providers` lists the providers the reader may use, with their kinds, labels, badges, tones and snippet labels, for the UI.
- Settings → Search (owners and admins) stores a Cohere, Voyage AI, Fireworks AI or compatible `/rerank` endpoint, model and key in `global_search_settings`, the key sealed with `sealSecret`. `GET/PUT /api/global-search/settings` and `POST /api/global-search/settings/test`.

## How to apply

1. Install with `pnpm plugin add`, then run `pnpm db:generate --name plugin-global-search`, read the SQL (one `CREATE TABLE global_search_settings` with its index and RLS policy) and run `pnpm db:migrate`.
2. To feed results from another plugin, declare a provider under `extensions['global-search.providers']` in that plugin's server entry, as the README shows.

## Conflicts to expect

None. The kit's own `/search` page (knowledge passages) is unchanged; this plugin's page is `/search/all`.

## Verify

1. `pnpm plugin check` passes.
2. `pnpm web test:api` passes `src/plugins/global-search/tests/api/global-search.test.ts`, including its tenant isolation cases.
3. Signed in, ⌘K opens the palette; typing "agents" offers the Agents page.
