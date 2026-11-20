---
name: analytics-queries
description: Query this app's analytics cubes — answer a data question, build a Cube-style query (measures, dimensions, filters, time dimensions, funnels, retention), call /cubejs-api/v1 from curl or a script with an API key, preview the SQL or explain plan, and connect Claude Code, Claude (claude.ai / Desktop) or ChatGPT to the app's own MCP server so they can explore and query the semantic layer through the analytics_discover / analytics_validate / analytics_load tools. Use when someone asks a question of the data ("how many…", "trend of…", "top N…"), wants to query or debug analytics, or wants to hook Claude/an MCP client up to the app's analytics.
argument-hint: "[ask \"<question>\" | build | curl | debug <query> | mcp-claude-code | mcp-claude-desktop | mcp-chatgpt]"
---

# Queries — ask the semantic layer, from Claude, a terminal or a script

Every query runs **as a person in one organisation**. Access comes from the app's own sign-in
cookie or an API key on `/cubejs-api`, or from an MCP connection (OAuth, the app's own sign-in) on
the `analytics_*` tools, and every cube filters its rows by that organisation's tenant. You never pass
a tenant id, and you never could. Any member may query (`read Analytics`).

## Preconditions

1. The app is running: `pnpm dev` locally (the Worker on `http://localhost:3001`, the UI on `:3000`),
   or a deployed URL (`APP_URL`).
2. **A credential** — for `/cubejs-api` only; an MCP client signs in with OAuth instead (the
   `mcp-*` modes below). An API key acts as the person who created it, in that key's organisation.
   Pick one of these:
   - **A dedicated key (recommended for Claude and scripts).** In the app, go to **Settings → API
     keys** (`/settings?tab=api-keys`) and create a key named after where it will live (for example
     `script:weekly-report`). Keys are created by owners and admins, and the key is **shown once**, so
     copy it then. It sees what its creator sees.
   - **The CLI's key.** `pnpm cli login --server http://localhost:3001` mints `cli:<hostname>` and
     stores it in `~/.rocketflare/config.json` (mode 0600). Don't copy it elsewhere; create a
     dedicated key instead, so each one can be revoked on its own.
   - Never paste a key into a file that gets committed, and never echo a full key in a transcript.
3. The plugin is healthy: the `analytics` skill, **Health** mode.

## The query language (0.12.2)

A query is JSON. Field names are always `CubeName.member`, exactly two parts. Get the real names
from `/meta` or the `analytics_discover` tool; never guess them.

```jsonc
{
  "measures":   ["ActivityEvents.count", "ActivityEvents.activeUsers"],
  "dimensions": ["ActivityEvents.type"],               // group by
  "filters":    [{ "member": "ActivityEvents.createdAt", "operator": "inDateRange", "values": ["last 30 days"] }],
  "timeDimensions": [{ "dimension": "ActivityEvents.createdAt", "granularity": "week" }],  // one row per week
  "order": { "ActivityEvents.count": "desc" },
  "limit": 10
}
```

- **Filtering by date is not grouping by date.** This is the most common mistake.
  - "Total events in the last 30 days" needs a `filters` entry with `inDateRange`. A
    `timeDimensions` entry with a `dateRange` and no `granularity` does the same: it filters and
    does not group.
  - "Events per week" needs `timeDimensions` with a `granularity`, and a `dateRange` on it if you
    want a window.
- **Missing time buckets are not filled.** `/load` and MCP `load` return only the buckets that
  have rows; the dashboards fill the gaps themselves. For a zero row per empty bucket, set
  `"fillMissingDates": true` on the time dimension.
- **Granularities:** `second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`.
- **Relative ranges, lower case only:** `'today'`, `'yesterday'`, `'tomorrow'`,
  `'last N days|weeks|months|quarters|years'`, `'this|last|next week|month|quarter|year'`, or an
  ISO pair `["2026-01-01", "2026-03-31"]`. Anything else (`'past 90 days'`) is a 400.
- **Filter operators:**
  - comparison: `equals`, `notEquals`, `gt`, `gte`, `lt`, `lte`, `between`, `notBetween`
  - text: `contains`, `notContains`, `startsWith`, `notStartsWith`, `endsWith`, `notEndsWith`,
    `like`, `ilike`, `regex`
  - sets and nulls: `in`, `notIn`, `set`, `notSet`, `isEmpty`, `isNotEmpty`
  - dates: `inDateRange`, `beforeDate`, `afterDate`
  - arrays: `arrayContains`, `arrayOverlaps`, `arrayContained`

  `values` is always an array, even for one value. `set`, `notSet`, `isEmpty` and `isNotEmpty`
  take none. An unknown operator is a 400.
- **AND / OR groups:** `{ "type": "or", "filters": [ …, … ] }`, and groups can nest.
- **Joins are automatic:** ask for `Users.email` next to `ActivityEvents.count` and it joins.
- **Raw rows instead of aggregates:** add `"ungrouped": true`, with dimensions only, and filter
  on dimensions only: a measure filter in an ungrouped query is a 400.
- **Comparing periods:** give the time dimension a `compareDateRange` (a list of ranges).
- **Analysis modes** work on event-stream cubes (`ActivityEvents`):
  - `{ "funnel": { "bindingKey", "timeDimension", "steps": [ … ] } }`: conversion between steps, at
    least 2 steps; `includeTimeMetrics` adds the time between steps.
  - `{ "flow": { … } }`: what came before and after an event.
  - `{ "retention": { "bindingKey", "timeDimension", "dateRange": { "start", "end" }, "granularity" } }`:
    cohorts that come back.

  The explorer (`/analytics/explore`) builds all three visually, and the MCP `discover` tool returns
  the full syntax.

## Mode: ask a question (`ask`)

1. **Find the members.** Call MCP `discover` with the topic if MCP is connected, or read `/meta`
   (below), or read `apps/web/src/plugins/analytics/cubes/*.ts`.
2. **Build the smallest query** that answers the question. Then decide: filter or group by time?
   Top N? (order plus limit)
3. **Validate** with MCP `validate` or `POST /cubejs-api/v1/dry-run`, then **run** it (`load`).
4. **Answer in words first**, then show the table, and say which members you used. If the result is
   empty, say so and suggest why: no data yet, a window that's too narrow, or a stale fact table (see
   `check-facts`).

## Mode: call it from a terminal (`curl`)

```bash
export RF_URL=http://localhost:3001                          # or your deployed APP_URL
read -rs RF_KEY && export RF_KEY                             # paste the key; nothing is echoed

# What cubes, measures and dimensions exist (this organisation's view)
curl -s "$RF_URL/cubejs-api/v1/meta" -H "Authorization: Bearer $RF_KEY" | jq '.cubes[] | {name, measures: [.measures[].name]}'

# Run a query
curl -s "$RF_URL/cubejs-api/v1/load" \
  -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["TenantUsers.count"],"dimensions":["TenantUsers.role"]}}' | jq '.results[0].data'

# Validate without running it, and see the SQL
curl -s "$RF_URL/cubejs-api/v1/dry-run" -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["ActivityEvents.count"]}}' | jq .
curl -s "$RF_URL/cubejs-api/v1/sql"     -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["ActivityEvents.count"]}}' | jq .

# The Postgres plan for a slow query
curl -s "$RF_URL/cubejs-api/v1/explain" -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["ActivityEvents.count"],"dimensions":["Users.email"]}}' | jq .
```

- Endpoints served here: `GET /meta`, `GET|POST /load`, `GET|POST /sql`, `GET|POST /dry-run`,
  `POST /explain` and `POST /batch` (`{"queries":[…]}`).
- A `load` response is `{ queryType, results: [{ data: [...], annotation, … }] }`, and the rows are
  in `results[0].data`.

**Success:** `/meta` lists `ActivityEvents`, `TenantActivityDaily`, `TenantUsers` and `Users` (plus
any contributed cubes), and `load` returns rows for your organisation only.

## Connecting an MCP client — what is the same for every client

The app's own MCP server (`<APP_URL>/mcp`, kit 0.41.0+) lists this plugin's three tools beside the
kit's knowledge tools:
- `analytics_discover`: finds cubes by topic and returns the full query syntax — call it first;
- `analytics_validate`: checks a query and suggests corrections;
- `analytics_load`: runs a query.

They are drizzle-cube's own MCP tools, read-only, answering exactly what `/cubejs-api` answers for
the same person. Before any client can connect:

1. **The deployment ships MCP**: `mcp` is in `FEATURES_ENABLED` (kit `SETUP.md` §2.10).
2. **An owner or admin turns it on** at **Settings → MCP**, and leaves the tools exposed — the
   default "all read-only tools" exposure includes all three. Under "Selected", tick them.
3. **The app is reachable over public https.** Claude (claude.ai / Desktop) and ChatGPT connect from
   their own servers, so locally that means `pnpm dev:tunnel`. ChatGPT cannot connect to local
   `wrangler dev` at all (kit `SETUP.md` §2.10) — use a deployed environment.
4. **Use the organisation's URL**, `<APP_URL>/mcp/t/<slug>` — Settings → MCP shows it with a copy
   button. claude.ai holds one connector per URL, so this is what lets a person connect a second
   organisation.

Sign-in is OAuth through the app's own login page and a consent screen; **API keys do not work on
`/mcp`**, and no key ever goes into a client's config. Each connection appears under Settings → MCP
→ Connected clients and the person's Profile → Connected apps, where either can revoke it.

## Mode: connect Claude Code (`mcp-claude-code`)

```bash
# Scope: local (default, just you, this project) | project (.mcp.json, shared) | user (all projects)
claude mcp add --transport http acme-analytics https://<your app>/mcp/t/<slug>
```

Then run `/mcp` in a session and pick the server: Claude Code opens the app's sign-in in your
browser, then the consent screen. Ask something like *"Using acme-analytics, how many active users
did we have per week over the last 90 days?"* A `--scope project` `.mcp.json` holds only the URL —
nothing secret — so it is safe to commit.

## Mode: connect Claude — claude.ai or Desktop (`mcp-claude-desktop`)

**Customize → Connectors → Add custom connector**, paste `https://<your app>/mcp/t/<slug>`, then
**Connect**. The browser goes to the app's sign-in and consent screen. If Claude says "Account
mismatch" before the app's sign-in page appears, that is Claude's own check, usually because the
browser is signed in to claude.ai as a different account from the Claude app — sign the browser in
to the same account and connect again. Check the tools under **+ → Connectors** in the message
box. No `mcp-remote`, no config file, no key.

## Mode: connect ChatGPT (`mcp-chatgpt`)

In ChatGPT's connector settings (developer mode), add a connector with the URL
`https://<your app>/mcp/t/<slug>` and OAuth. ChatGPT identifies itself with a client metadata
document; the app accepts it on a deployed environment (not on local `wrangler dev`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 401 `unauthorized` on `/cubejs-api` | missing or wrong `Authorization: Bearer`, or the key was revoked | create a new key; check that there's no stray space or newline in it |
| an MCP client keeps asking to sign in, or 401 on `/mcp` | its connection was revoked or lapsed (30 days idle, 90 in total) | reconnect from the client |
| 403 on `/mcp` | MCP is off for the organisation, or the person is outside its "who can connect" policy | Settings → MCP |
| the `analytics_*` tools are not listed | exposure is "Selected" without them, or the deployment does not ship this plugin release | Settings → MCP → Tools |
| 403 `no_tenant` | a cookie session with no organisation selected | use an API key, or pick an organisation at `/select-tenant` |
| HTML instead of JSON | `/cubejs-api` is missing from `run_worker_first` or the Vite proxy | the `analytics` skill, Health |
| 400 `Unknown member …` | a guessed field name | copy names from `/meta` or `analytics_discover` |
| 400 naming a date range | a relative date string drizzle-cube does not parse | use `last N days` or an ISO pair |
| numbers lag reality on `TenantActivityDaily` | the fact table rebuilds hourly at `:15` | `pnpm cli analytics check-facts`, then `refresh-facts` (admin) |
| a cube missing from `/meta` | its feature is off for this organisation (`FEATURE_CUBES`) | turn the feature on for the tenant, or query another cube |

## Sources

- Claude Code MCP (`claude mcp add --transport http`, scopes, `.mcp.json`, `/mcp` to authenticate): https://code.claude.com/docs/en/mcp
- Custom connectors (OAuth, brokered from Anthropic's servers, must be publicly reachable): https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- ChatGPT connectors and their OAuth (client metadata documents): https://developers.openai.com/apps-sdk/build/auth
- The app's MCP server: the kit's `docs/CONCEPTS.md` §19 and `SETUP.md` §2.10
- drizzle-cube docs: https://www.drizzle-cube.dev
