# global-search

> One ⌘K palette to go anywhere, run a command or find anything a person may see in your app.
> Any installed plugin can add results and commands to it.

Press ⌘K (Ctrl-K elsewhere) on any page, or click the search box in the middle of the top bar, and
type. The first rows appear as you type, with no request: **Go to** (every page and settings tab you
may open, from the kit's own navigation) and **Commands** ("New chat", "Invite people"…). Below
them come the server's results from every registered provider, grouped by kind. "Search everything"
opens `/search/all`, the full ranked list with kind filters.

Out of the box the server finds the organisation's **people** (owners and admins), **agents**, your
own **chats** and **documents** (keyword and meaning, through the kit's hybrid search). Any other
plugin adds results by declaring a provider under `extensions`, and commands by declaring them on
its UI entry, without importing this plugin. Each organisation can also plug in its own re-ranking
model.

## What it adds

| Area | What you get |
|---|---|
| UI | A search box in the header (`UiPlugin.header`, centre) and the ⌘K palette: instant **Go to** and **Commands** rows, grouped server results, keyboard navigation, recent items. `/search/all`: every server result, kind facets with counts. **Settings → Search** for owners and admins: the re-ranker |
| Go to | Every destination from the kit's `useNavigationEntries()`: the side nav (core and plugins'), the settings tabs, the Home quick links — already filtered to what the reader may open. Ranked in the browser: prefix, word start, then letters in order, over label, group and keywords |
| Commands | `extensions['global-search.commands']` on any plugin's UI entry; built in: New chat, Invite people, Upload a document, Create an API key — each behind the guard of the page it opens |
| Providers | `global-search:people` (members by name or email; `manage TenantMember`), `global-search:agents` (registered agents by title, key or description; `read AgentRun`), `global-search:chats` (the reader's own conversations by title; `read Conversation`), `global-search:documents` (tenant documents through `searchKnowledge`, one hit per document, deep-linked to its best passage; `read Document`) |
| Extension point | `extensions['global-search.providers']` (server) and `extensions['global-search.commands']` (UI): any plugin registers; both validated with zod at runtime |
| Ranking | Reciprocal Rank Fusion (k = 60) over every provider's list, keyed by `href`; optional re-ranking of the top 50 by a Cohere, Voyage AI, Fireworks AI or compatible `/rerank` endpoint |
| API | `GET /api/global-search?q&kinds&limit`, `GET /api/global-search/providers`, `GET/PUT /api/global-search/settings`, `POST /api/global-search/settings/test` |
| Data | `global_search_settings`: one row per organisation, the re-ranker key sealed with the kit's encryption, row-level security |

## Requirements

- Rocketflare kit **0.31.0** or later (`searchKnowledge`, `listAgents`, `UiPlugin.header`,
  `useNavigationEntries` and `UiPlugin.extensions`).
- The kit's knowledge base (`feature-knowledge`). Without an embeddings provider, documents are
  matched by keyword only, and the palette says so.
- `OAUTH_ENCRYPTION_KEY` set in the app, only if an organisation saves a re-ranker key. Without it,
  saving a key answers 503 `encryption_key_missing`.

## Install

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.10.1 --subdir plugins/global-search
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@3.10.1 --subdir plugins/global-search --apply
pnpm db:generate --name plugin-global-search-3.10.1 && pnpm db:migrate
```

The first command prints the plan and stops; `--apply` installs.

## First run

1. Sign in and press ⌘K. Type "sett": Settings and its tabs appear at once. Type "inv" for
   Invite people, a colleague's name, an agent's name, or words from a document you uploaded.
2. Use the arrow keys and Enter to open a result. Reopen the palette with an empty box to see your
   recent items.
3. Choose "Search everything" to open `/search/all` and filter by kind.
4. Optional: as an owner or admin open **Settings → Search**, pick a re-ranker preset, paste the
   organisation's key, press **Test**, then **Save**. The first complete save turns re-ranking on.

## Adding results from another plugin (an entity provider)

A provider is a ranked list of your plugin's things — tickets, customers, orders. Declare it in your plugin's server entry. Don't import this plugin: an
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

### Matching by name

Most entities are found by what they are called; no embeddings are needed. Filter by the tenant,
match with an escaped `ILIKE` so a `%` in the query is text, and put exact matches first:

```ts
async search(ctx, { q, pool }) {
  const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`
  return (
    await ctx.db
      .select({ id: tickets.id, title: tickets.title })
      .from(tickets)
      .where(and(eq(tickets.tenantId, ctx.tenantId), sql`${tickets.title} ILIKE ${like} ESCAPE '\\'`))
      .orderBy(sql`lower(${tickets.title}) = lower(${q}) DESC`, asc(tickets.title))
      .limit(pool)
  ).map(t => ({ kind: 'ticket', title: t.title, snippet: null, ref: t.id, href: `/tickets/${t.id}` }))
}
```

Give every row its own `href` (it is the fusion key), and add a two-tenant test.

## Adding a command from another plugin

A command is a named place to go — "New ticket", "Billing settings". It is matched in the browser as
the reader types, with no request. Declare it on your plugin's UI ENTRY, which ships in the main
bundle, so it is plain data:

```ts
export const myUi = {
  shared: myShared,
  routes: [{ path: '/tickets/new', Component: NewTicketPage, guard: TICKETS_GUARD }],
  extensions: {
    'global-search.commands': [
      {
        id: 'my-plugin:new-ticket',            // '<your plugin id>:<name>'
        label: 'New ticket',
        to: '/tickets/new',                     // an in-app path
        keywords: ['create', 'issue'],
        guard: TICKETS_GUARD,                   // the same guard as the route
      },
    ],
  },
} satisfies UiPlugin<typeof myShared>
```

`guard` uses the kit's `NavGuard` vocabulary (`'admin'`, `{ action, subject }`, `{ feature }`, or a
list meaning all of them), so a command is hidden exactly when a nav item with that guard would be.
`group` sets the heading (default "Commands"). Your plugin's pages need no command: its nav items,
settings tabs and Home links already appear under **Go to**. A command that does not parse, or
whose id is outside your plugin's namespace, is logged and left out, and this plugin's
`command-palette` test fails the host's gate on it.

## Using it with your coding agent

There is no dedicated skill; the kit's `rf-plugin` skill installs, upgrades and audits it. Point
your agent at the plugin's
[`CLAUDE.md`](apps/web/src/plugins/global-search/CLAUDE.md) to add a provider or change ranking.

## Permissions and data

- Every signed-in member can search. Each provider decides what that person may find: the documents
  provider searches through the reader's own access scope, so restricted documents stay hidden, and a
  guarded provider is neither called nor listed for someone without the permission.
- People are offered only to those who may manage members (owners and admins), the readers of
  Settings → People. Chats are private: the chats provider returns only the reader's own, for an
  owner as for a member, exactly as the kit's `/chat` does.
- Go to and Commands come from the browser and show only what the kit's own guards let the reader
  open. They are cosmetic, like the nav: the pages they open still check on the server.
- Only tenant documents are searched. Platform documents (kit 0.31.0, readable by every tenant) are
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
- **Go to and Commands are not on `/search/all`.** They are the palette's instant rows; the page
  lists the server's results.
- **A person opens Settings → People, not that person.** The kit has no page per member, so a
  person's result opens the People tab (with `&member=<id>`, which the tab ignores today).
- **Agents are matched in memory.** The catalogue is code, small and the same for every tenant, so
  the agents provider filters `listAgents()` rather than querying.
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
