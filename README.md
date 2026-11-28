# rocketflare-plugins

The first-party plugins for [Rocketflare](https://github.com/rocketflare-dev/rocketflare).

**These are not npm packages.** A Rocketflare plugin is a git repository *copied into* your app —
exactly like the kit itself — so its code lands as ordinary source you can read, debug and edit,
translated into your app's own vocabulary on the way in. The price is that an upgrade is a patch
rather than a version bump, which the kit's tooling already knows how to do.

## The plugins

Each plugin has its own README with what it adds, requirements, install and first-run steps, who
sees what and its known gaps. They are also published at
[rocketflare.dev/plugins](https://rocketflare.dev/plugins/).

| Plugin | What it adds | Needs |
|---|---|---|
| [**analytics**](plugins/analytics/README.md) | Dashboards, tenant-scoped drizzle-cube cubes at `/cubejs-api` and `/mcp`, an hourly fact table, CLI, and four `analytics-*` agent skills. Installed by the kit's bootstrap | kit 0.48.0 |
| [**web-knowledge**](plugins/web-knowledge/README.md) | `web_search` and `fetch_page` tools for agents and chat on each organisation's own key (Tavily, Brave, Exa, Serper, Firecrawl), Settings → Web search | kit 0.48.0 |
| [**connectors**](plugins/connectors/README.md) | Organisation connections: admin consent once, then hourly directory and calendar sync; Settings → Connections, My calendar, CLI and the `connectors` setup skill | kit 0.48.0 and a provider |
| [**m365**](plugins/m365/README.md) | Microsoft 365 as a `connectors` provider: Entra admin consent, app-only Graph delta sync of users, groups and calendars | kit 0.29.0 and `connectors` |
| [**issue-reports**](plugins/issue-reports/README.md) | Ideas & issues: anyone talks a bug or an idea through with an agent that asks until it is clear, checks for a duplicate, and logs it as a GitHub issue (or a comment) once they approve the draft | kit 0.29.0 and a GitHub token |
| [**inbox**](plugins/inbox/README.md) | Inbound email through Cloudflare Email Routing: per-organisation address and sender allow-list, SPF/DKIM/DMARC checks, parsed bodies and attachments, Gmail/Proton forwarding-confirmation codes, an Inbox page, CLI, read-only agent tools, and an `inbox:consumers` extension other plugins build on | kit 0.48.0 and Email Routing on the domain |
| [**freeagent**](plugins/freeagent/README.md) | FreeAgent (UK accounting) per organisation: OAuth connection, an hourly incremental mirror of bank transactions, explanations, categories, contacts, bills and invoices, Settings → FreeAgent and a FreeAgent page, read tools plus approval-gated write tools for agents, analytics cubes, CLI, a service API and a `freeagent:sync-listeners` extension for plugins built on top | kit 0.48.0 and a FreeAgent app |
| [**guide**](plugins/guide/README.md) | An in-app user guide about your app: markdown pages in `docs/guide/` stored as always-embedded platform knowledge, a reader with semantic search and Ask (chat with page citations), a `?` header button, the `/guide` skill, and a Claude Code Stop hook that tells your coding agent when the guide may be stale | kit 0.48.0 and an embeddings provider |
| [**global-search**](plugins/global-search/README.md) | A ⌘K palette and `/search/all` page: instant Go to over everything you may open, commands, people, agents, your chats and documents, fused with RRF and an optional reranker; any plugin adds results through `global-search.providers` and commands through `global-search.commands` | kit 0.31.0 |

## Installing one

```bash
# Read the plan first — it always prints and stops.
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@analytics-v3.15.0 --subdir plugins/analytics
# Then install it.
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@analytics-v3.15.0 --subdir plugins/analytics --apply
# The HOST generates the migration. Always.
pnpm db:generate --name plugin-analytics-<version> && pnpm db:migrate
```

Each plugin has its own tag, `<id>-vX.Y.Z`; its README names its newest one. A plugin with no
release of its own yet installs from the last shared tag, `3.14.0`. `pnpm plugin list --available`
(kit 0.47.0 or later) lists each plugin at its newest release, either tag form.

`--subdir` is what tells `pnpm plugin add` which plugin in this repository you mean; each plugin
also records its own subdirectory in its `rocketflare-plugin.json`, so `pnpm plugin upgrade
<id>` later needs no flag.

Installing a plugin gives it full Worker and database access — it is as trusting as merging a pull
request — which is why every command prints its plan and waits for `--apply`.

## Layout

```
rocketflare-plugins/
  package.json                    the release scripts (no version: each plugin has its own)
  CHANGELOG.md                    the human index; the porting notes live per plugin
  scripts/                        the release tooling (see below)
  .github/workflows/ci.yml        one job per plugin, calling the kit's reusable workflow
  .github/workflows/plugin-matrix.yml  the release-time matrix, calling the kit's (see CI)
  plugins/<id>/
    rocketflare-plugin.json       what makes a directory a plugin; carries ITS version
    apps/web/src/plugins/<id>/**  }
    packages/shared/src/plugins/<id>/**  }  mirrors the host tree exactly
    apps/cli/src/plugins/<id>/**  }
    docs/upgrades/*.md            one porting note per release
```

Each `plugins/<id>/` **mirrors the host tree exactly**, because that is what the kit's installer
expects: `classifyPluginFile` refuses any path outside `apps/web/src/plugins/<id>/`,
`packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/` and `docs/plugins/<id>/` once the
subdir prefix has been stripped. A plugin ships **no migration, no wrangler toml and no
`package.json`** — those three are the host's, always.

A plugin's release notes live in `plugins/<id>/docs/upgrades/` and nowhere else. `pnpm plugin add`
copies them to the host's `docs/plugins/<id>/upgrades/`, and `pnpm plugin export` copies that host
directory back verbatim. After an export, delete `plugins/<id>/docs/plugins/`
(`find plugins -path '*docs/plugins*'` should print nothing): that copy duplicates the notes at the
same host path, and it is how 3.6.0 shipped two of them.

## The plugin API

A plugin's compatibility with a kit is **observed, not declared**. `pnpm plugin export` derives the
manifest's `uses` block from the plugin's actual imports, and `pnpm plugin add` checks it against
the kit's surface ledger (`docs/plugin-api.md` in the kit) before copying anything. The one
declared number is the top-level `minKit`, the oldest kit release the plugin may be installed into.
`requires.kit` and `requires.pluginApi` are gone and are refused by name.

## One plugin, one version, one tag

Each plugin is released on its own schedule (rocketflare-dev/rocketflare#181): its version lives
in its `rocketflare-plugin.json` (and the anchor `plugin.json`), and a release is tagged
`<id>-vX.Y.Z`, for example `freeagent-v3.15.0`. `-v` rather than `@`, because `pnpm plugin add
<repo>@<ref>` splits on its last `@`. A plugin with no change is never re-released.

Up to and including `3.14.0` every plugin shipped at one version under a plain `X.Y.Z` tag. Those
tags stay valid, and each plugin's own version line continues from there. The kit's resolver
(0.47.0 and later) reads both forms and takes the newer release of each plugin; a copy on an older
kit keeps resolving `3.14.0`, which is stale but not broken.

`minKit` is information: the kit the plugin was proven on when it set that floor.

## The shared tooling

`scripts/` holds the release tooling, at the repository root and so **outside every
`plugins/<id>/` directory**: `classifyPluginFile` never sees these files and they cannot leak into
a host app by construction.

- `release-plugin.mjs` is this repository's own: it releases one plugin or a named set.
- `lib/upgrade-lib.mjs` and `lib/rename-lib.mjs` are copied from the kit
  (`rocketflare-dev/rocketflare`, `scripts/lib/`) for the note parser and version order; when the
  kit's move, copy them again rather than editing them in place.
- `release-site-nudge.mjs` and `lib/nudge-lib.mjs` are the Claude Code hook that reminds you to
  update rocketflare.dev after a release commit.

## Releasing

Release only the plugins that changed, on a branch:

1. Each one has a non-empty `plugins/<id>/docs/upgrades/unreleased.md`, written in the same pull
   request as the change. The script refuses an empty one.
2. Name each plugin with its new version:

   ```bash
   node scripts/release-plugin.mjs freeagent@3.15.0 inbox@3.15.0
   ```

   For each it folds `unreleased.md` into `<X.Y.Z>.md` (`previous` is that plugin's own last
   release), resets `unreleased.md`, stamps that plugin's `rocketflare-plugin.json` and anchor
   `plugin.json`, and prepends a `## <id> <X.Y.Z> — <date>` section to `CHANGELOG.md`.
3. Move the install refs in that plugin's `README.md` and in the table above to `@<id>-vX.Y.Z`;
   the script does not touch them.
4. `node scripts/release-plugin.mjs --check freeagent-v3.15.0 inbox-v3.15.0` must report
   `release check ok`.
5. Commit `Release freeagent 3.15.0, inbox 3.15.0`, open a PR, and once it merges tag the merge
   commit `<id>-vX.Y.Z` for each plugin and push the tags **one at a time**: GitHub starts no
   workflow for a push of more than three tags at once, and each tag starts the plugin matrix.
6. Create a GitHub Release per tag (`gh release create <id>-vX.Y.Z --title "<id> X.Y.Z"`), then
   update rocketflare.dev (`sync:plugins` reads the per-plugin tags).

**Released history is never rewritten.** Every app pins a commit of this repository; a force-push
to a released tag orphans them.

## CI

`.github/workflows/ci.yml` calls the kit's reusable `plugin-ci.yml` **once for the whole
repository**, passing `plugin_subdirs`, on every push and pull request. For each plugin it clones
the **newest** kit release, installs this checkout into it (after the plugins its
`requires.plugins` names), generates and applies the migrations the host owns, and runs the kit's
whole gate. There is no `minKit` floor job: a floor is proven on the day it is raised, because the
kit it names is the newest then, and every kit tag re-proves each plugin's latest release. A
`minKit` that names no released kit fails the run.

**The plugin matrix** (rocketflare-dev/rocketflare#180) proves the RELEASED plugins, from both
ends, with one workflow — the kit's `plugin-matrix.yml`: a `matrix <id>` job per plugin and one
full-house job with every plugin installed together, each at its own newest release. The kit runs
it on every kit tag; `.github/workflows/plugin-matrix.yml` here calls it on every `<id>-vX.Y.Z`
tag, for that plugin plus the full house, against the newest kit release (and on
`workflow_dispatch`, with a plugin set, a ref of this repository or a kit ref). A failing plugin
fails its job and the run; the run's summary has one row per plugin, with its value-check warning
count. Nothing opens or edits an issue.

A failure means the kit has moved under the plugin, or the plugin has started using something
newer than its `minKit`: port the plugin, raise `minKit` if it needs to, and release it.

## Adding a plugin to this repository

Create `plugins/<id>/` with a `rocketflare-plugin.json` and a `README.md` (the site publishes it) (`id`, `version`, `repo` pointing here,
`subdir: "plugins/<id>"`, `minKit`), mirror the host tree beneath it, add a row to the table
above and a line to the `plugin_subdirs` array in `ci.yml`. Namespace everything with the id — tables `<id>_*`, job types
`<id>.x`, query-key roots `<id>:…`, the API prefix `/api/<id>` — because two plugins have to be
able to live in one app.

## Security

A plugin runs in the same Worker as the app, with no sandbox, so a hole in a plugin is a hole in
every app that installs it. The kit's threat model has a section for plugin authors
([For plugin authors](https://rocketflare.dev/security/threat-model/#for-plugin-authors), or
`docs/THREAT-MODEL.md` in the kit). It covers what a plugin is trusted with, what to assume about
each caller, what the kit's seams guarantee, and what a plugin must prove itself. In short:

- **Tenant isolation is yours to prove.** Every tenant table calls `tenantIsolation()` and every
  query filters by the tenant from the context. Each plugin's api tests show that tenant B cannot
  list, read, change or delete tenant A's rows, and a query surface the kit cannot see (a cube, an
  index, an export) gets its own isolation case. `pnpm plugin check` proves such a test exists, not
  that it is right.
- **Check roles on the server**, through the request's ability or `ToolCtx.can`, never in the UI
  alone. A row hidden from a caller answers the same 404 as a missing one.
- **Credentials are sealed and never returned.** Use `sealSecret` with a `*_enc` column, and answer
  `hasCredential`. Never log a credential or put it in a model prompt.
- **Public mounts prove their caller.** A handler under `/api/hooks/<id>` has no tenant until a
  signature or `verifyState` names one. `verifyState` has no replay ledger, so a callback that
  must run once records that itself.
- **Model tools act within the requester's grant.** Gate writes on the requester's `manage`
  grant, and fetch only URLs the person wrote (`ToolCtx.requesterUrls`) or the tool's own search
  returned.

Before a release that changes any of this, audit a host app with the plugin installed: run
`/rf-security` in a kit checkout and ask it to install the plugin from your checkout of this
repository. The runner's form is `host --plugin <checkout>:plugins/<id>`, for example
`--plugin ../rocketflare-plugins:plugins/inbox` (the kit's `docs/SECURITY-AUDIT.md`). To report
a vulnerability, see [`SECURITY.md`](SECURITY.md).

## History

`analytics` was released from `rocketflare-dev/rocketflare-plugin-analytics` up to and including
`1.0.2`. That repository is unchanged and its tags still install; this one continues from there.

## Licence

MIT, the same as the kit. See `LICENSE`. Each plugin also carries a copy in
`apps/web/src/plugins/<id>/LICENSE`, so the notice travels into every app it is installed in.
