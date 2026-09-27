# web-knowledge

> Web search and page reading for your app's agents and chat, on each organisation's own search API
> key.

An admin picks a search provider, saves the organisation's key, tests it and turns it on. From then
on that organisation's chat turns and agent runs carry two more tools, `web_search` and
`fetch_page`. No other organisation gets them, and the key never leaves the server.

## What it adds

| Area | What you get |
|---|---|
| UI | **Settings → Web search**: choose a provider, save and test a key, turn search on or off. Members see it read-only |
| Agent tools | `web_search` (query → ranked results) and `fetch_page` (a URL → readable text, windowed to the run's document budget), offered only while the organisation's settings are enabled and hold a key |
| Providers | Tavily, Brave, Exa, Serper and Firecrawl |
| API | `GET/PUT /api/web-knowledge/settings`, `POST /api/web-knowledge/settings/test` |
| Data | `web_search_settings` — one row per organisation, the key sealed with the kit's encryption, row-level security |
| CLI | `rocketflare web-knowledge status [--json]` (read-only — keys don't belong in shell history) |

## Requirements

- Rocketflare kit **0.9.0** or later.
- `OAUTH_ENCRYPTION_KEY` set in the app (the kit's key for sealing credentials). Without it, saving a
  key answers 503 `encryption_key_missing`.
- An API key from one of the supported providers, per organisation. No other plugin, binding or
  secret.

## Install

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.4.0 --subdir plugins/web-knowledge
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.4.0 --subdir plugins/web-knowledge --apply
pnpm db:generate --name plugin-web-knowledge-3.4.0 && pnpm db:migrate
```

The first command prints the plan and stops; `--apply` installs.

## First run

1. Sign in as an owner or admin and open **Settings → Web search**.
2. Choose a provider and paste the organisation's key. The first key saved turns search on.
3. Press **Test** — it always answers with a verdict (`key_rejected`, `rate_limited`, `timeout`…)
   rather than an error page.
4. Ask the chat something that needs the web; the reply cites what `web_search` found.
5. `rocketflare web-knowledge status` shows the provider, whether a key is stored and whether search
   is on.

## Using it with your coding agent

There is no dedicated skill; the kit's `rf-plugin` skill installs, upgrades and audits it. To add a
provider, ask your agent — the plugin's `CLAUDE.md` lists the three steps it takes.

## Permissions and data

- Owners and admins manage the settings; members and support read them.
- Routes only ever answer `hasCredential`, never the key; the activity log records that a key was
  set, kept or cleared, never its value.
- The key is decrypted only at the moment of the outbound call, inside the tool or the test route.
- `fetch_page` refuses non-http(s) URLs, non-default ports, IP literals and local or private host
  names, re-checks every redirect, caps pages at 2 MB, and marks page text as untrusted for the
  model.

## Known gaps

- The URL guard checks names, not addresses: a public hostname that resolves to a private address
  gets through (a Worker has no DNS API). Deployed on Cloudflare a Worker cannot reach private
  space anyway; under `wrangler dev` it can.
- No platform-wide fallback key, no quotas and no usage ledger — the provider bills the
  organisation's key.
- Without provider-side extraction (Brave, Serper), `fetch_page` cannot read pages rendered by
  JavaScript.

## More

- [`CLAUDE.md`](apps/web/src/plugins/web-knowledge/CLAUDE.md) — the plugin's reference.
- [Upgrade notes](docs/upgrades/) — one per release.
- The kit's [plugins section](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#16-plugins)
  and [AI layer](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#9-ai-layer).
