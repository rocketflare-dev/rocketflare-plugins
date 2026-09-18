---
version: unreleased
previous: null
date: null
breaking: false
migrations:
  - "web_search_settings — one row per tenant (unique tenant_id): provider, sealed api_key_enc, enabled, max_results; RLS policy"
areas: [shared, db, api, ui, cli, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The first release: web search for agents and chat on each organisation's own key (Tavily, Brave, Exa, Serper or Firecrawl), configured in Settings → Web search and offered only to tenants that turn it on.

- `web_search` and `fetch_page` agent tools, offered through an async `agentTools` only to tenants whose settings are enabled with a key.
- Settings → Web search tab: provider, sealed API key (`sealSecret`), max results, a live Test, read-only for members.
- `GET|PUT /api/web-knowledge/settings`, `POST /api/web-knowledge/settings/test`.
- `rocketflare web-knowledge status [--json]`.

## How to apply

1. Confirm the kit is 0.9.0 or later, the first release with async `agentTools` and `sealSecret`.
2. Run `pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/web-knowledge`, read the plan, then re-run it with `--apply`.
3. Run `pnpm db:generate --name plugin-web-knowledge-<version>` and `pnpm db:migrate`.
4. Confirm `OAUTH_ENCRYPTION_KEY` is set in every environment; without it, saving a key answers 503 `encryption_key_missing`.
5. As an organisation admin, open Settings → Web search, save a provider key, press Test, then turn web search on.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` reports `web-knowledge` checks out.
2. The generated migration's SQL creates `web_search_settings` and its RLS policy, and nothing else.
3. `pnpm test` passes, including `src/plugins/web-knowledge/tests/**`.
4. With web search off, chat stats list no `web_search` tool; with it on and a key saved, they list `web_search` and `fetch_page`.
