# global-search

> One ⌘K palette and one results page over everything a person may see in your app, which any
> installed plugin can feed with results.

Press ⌘K (Ctrl-K elsewhere) on any page, or click the search box in the middle of the top bar, and
type. The palette searches every registered provider at once, groups the results by kind and opens
the one you pick. "Search everything" opens `/search/all`, the full ranked list with kind filters.

Out of the box it searches the organisation's knowledge-base documents (keyword and meaning, through
the kit's own hybrid search) and the app's own pages by name. Any other plugin adds a provider by
declaring one under `extensions`, without importing this plugin. Each organisation can also plug in
its own re-ranking model.

## What it adds

| Area | What you get |
|---|---|
| UI | A search box in the header (`UiPlugin.header`, centre) and the ⌘K palette: grouped results, keyboard navigation, recent items. `/search/all`: every result, kind facets with counts. **Settings → Search** for owners and admins: the re-ranker |
| Providers | `global-search:documents` (tenant documents through `searchKnowledge`, one hit per document, deep-linked to its best passage; guarded by `read Document`) and `global-search:nav` (the kit's core pages by name, each behind its own guard) |
| Extension point | `extensions['global-search.providers']`: any plugin registers providers; validated with zod at runtime |
| Ranking | Reciprocal Rank Fusion (k = 60) over every provider's list, keyed by `href`; optional re-ranking of the top 50 by a Cohere, Voyage AI, Fireworks AI or compatible `/rerank` endpoint |
| API | `GET /api/global-search?q&kinds&limit`, `GET /api/global-search/providers`, `GET/PUT /api/global-search/settings`, `POST /api/global-search/settings/test` |
| Data | `global_search_settings`: one row per organisation, the re-ranker key sealed with the kit's encryption, row-level security |

## Requirements

- Rocketflare kit **0.30.0** or later (`searchKnowledge` and `UiPlugin.header`).
- The kit's knowledge base (`feature-knowledge`). Without an embeddings provider, documents are
  matched by keyword only, and the palette says so.
- `OAUTH_ENCRYPTION_KEY` set in the app, only if an organisation saves a re-ranker key. Without it,
  saving a key answers 503 `encryption_key_missing`.

## Install

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@<version> --subdir plugins/global-search
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@<version> --subdir plugins/global-search --apply
pnpm db:generate --name plugin-global-search && pnpm db:migrate
```

The first command prints the plan and stops; `--apply` installs.

## First run

1. Sign in and press ⌘K. Type a page name ("agents") or words from a document you uploaded.
2. Use the arrow keys and Enter to open a result. Reopen the palette with an empty box to see your
   recent items.
3. Choose "Search everything" to open `/search/all` and filter by kind.
4. Optional: as an owner or admin open **Settings → Search**, pick a re-ranker preset, paste the
   organisation's key, press **Test**, then **Save**. The first complete save turns re-ranking on.

## Adding a provider from another plugin

A provider is a ranked list. Declare it in your plugin's server entry. Don't import this plugin: an
app without it installed must still compile.

```ts
export const myServer = {
  shared: myShared,
  extensions: {
    'global-search.providers': [
      {
        id: 'my-plugin:tickets',            // '<your plugin id>:<list>'
        label: 'Tickets',
        kinds: [{ kind: 'ticket', label: 'Tickets', badge: 'ticket', tone: 'warning', order: 20 }],
        guard: { action: 'read', subject: 'Ticket' },   // optional; skipped without it
        async search(ctx, { q, pool, kinds, signal }) {
          // ctx: { db, config, env, scope, tenantId, userId, isAdmin, can }
          // Filter by ctx.tenantId (and ctx.scope), return at most `pool` hits, best first.
          return [{ kind: 'ticket', title: 'T-1 Login fails', snippet: null, ref: 'T-1', href: '/tickets/T-1' }]
        },
      },
    ],
  },
} satisfies ServerPlugin<typeof myShared>
```

The full contract, with every field explained, is in
[`packages/shared/src/plugins/global-search/index.ts`](packages/shared/src/plugins/global-search/index.ts)
(`SearchProviderOf`, `SearchProviderKind`, `SearchProviderHit`, `SearchProviderInput`). The rules:

- `id` is `<plugin id>:<list>`, and the plugin half must be your own plugin's id. Ids are unique, and
  each `kind` belongs to one provider.
- `href` must be an in-app path (`/…`, never `//…` or a URL). It is both the link and the fusion key,
  so two providers that find the same page produce one result.
- Each provider gets 1.5 seconds and an `AbortSignal`. Pass the signal to `fetch` and to
  `searchKnowledge`. A provider that is slow, throws, or answers something that does not parse is
  reported in `degraded` and the rest of the results still arrive.
- A hybrid provider can set `halves` (`lexical` / `dense` ranks) and a `weight` of 0 to 1 per hit.
  The kit convention is 0.5 for a hit only the dense half found. If it can tell, it calls
  `reportSemantic('used' | 'unavailable')`.
- Snippets may be markdown. If they carry `Label: value` fields, declare `snippetLabels` so the
  palette shows them as a person would read them.
- A registration that does not parse is refused loudly: the search route answers 500 and the log
  names the plugins that contributed. This plugin's `installed-providers` test fails the host's gate
  first.

## Using it with your coding agent

There is no dedicated skill; the kit's `rf-plugin` skill installs, upgrades and audits it. Point
your agent at the plugin's
[`CLAUDE.md`](apps/web/src/plugins/global-search/CLAUDE.md) to add a provider or change ranking.

## Permissions and data

- Every signed-in member can search. Each provider decides what that person may find: the documents
  provider searches through the reader's own access scope, so restricted documents stay hidden, and a
  guarded provider is neither called nor listed for someone without the permission.
- Only tenant documents are searched. Platform documents (kit 0.30.0, readable by every tenant) are
  never included by the built-in provider.
- Owners and admins manage the re-ranker settings. The key is sealed at rest, decrypted only at the
  moment of a search, and never returned: routes answer `hasCredential`. The activity log records
  that a key was set, kept or cleared, never its value.
- When re-ranking is on, the query and the top results' titles and snippets are sent to the
  organisation's re-ranker. Only `https://` URLs are accepted.
- The re-ranker gets 1.5 seconds. If it is slow or fails, results keep their fused order and
  `ranking.rerank.reason` says why. A search never fails because of the re-ranker.

## Known gaps

- **The query is embedded once per `searchKnowledge` call.** The documents provider and any other
  provider that calls `searchKnowledge` (the guide plugin, for one) each embed the same query, so one
  search can make two or more embeddings calls. Fixing it needs a kit change that shares a query
  vector across calls.
- **The documents list holds at most 20 passages** (`SEARCH_MAX_LIMIT`), so a broad query reaches at
  most 20 documents through it.
- **The nav provider is a static list of the kit's core pages.** The kit exposes its navigation,
  including plugins' nav groups, only to the browser, while providers run on the server. Another
  plugin's pages appear only through that plugin's own provider.
- **An embeddings outage loses the documents list for that search.** `searchKnowledge` falls back to
  keywords when no embeddings provider is configured, but an outage throws. The provider is then
  reported in `degraded` as `error`.
- **Re-ranker calls are not metered.** Nothing is written to `ai_usage`; the vendor bills the
  organisation's key.
- **A provider that ignores its `AbortSignal` keeps running** after its budget. The search no longer
  waits for it, but the Worker still does the work until it ends.

## More

- [`CLAUDE.md`](apps/web/src/plugins/global-search/CLAUDE.md): the plugin's reference.
- [Upgrade notes](docs/upgrades/): one per release.
- The kit's [plugins section](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#16-plugins)
  and [AI layer](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#9-ai-layer).
