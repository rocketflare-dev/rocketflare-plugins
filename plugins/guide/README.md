# guide

> An in-app user guide about your app itself: written by your coding agent, kept in step with the
> code by a Claude Code hook, searched by meaning and answered from by "Ask the Guide".

The guide is markdown in your repository (`docs/guide/`). Your coding agent writes it from the
code with `/guide init`. When you later change a screen a page describes, the Stop hook says so in
one line, and `/guide sync` re-checks those pages against the code. In the app, every signed-in
member reads it at `/guide`, searches it, and asks it questions from any screen with **?**.

## What it adds

| Area | What you get |
|---|---|
| UI | `/guide`: a three-pane reader (contents with search, the page, Ask the Guide) with prev/next and a page picker on mobile. A **User guide** nav item and Home link. A **?** button in the header (and the <kbd>?</kbd> key when you aren't typing) that opens Ask the Guide over any screen |
| Ask the Guide | A streamed answer (AG-UI) from the guide only, through one tool, `search_guide`, with citation chips that open the cited section. It knows which screen you asked from, through the config's `screens` map |
| Search | One platform knowledge document per page section, always embedded, so search is semantic as well as keyword. The kit's `search_knowledge` covers the guide for chat and agents too. Every agent run also gets `search_guide` |
| Audiences | `audience: member` or `admin` per page. An admin page doesn't exist for a member: it isn't in the contents, its URL is a 404 and search never returns it |
| API | `GET /api/guide/toc`, `GET /api/guide/page?path=`, `GET /api/guide/search?q=`, `POST /api/guide/ask`, all for signed-in members only |
| Jobs | `guide.sync` (a daily cron, plus a check on every `/api/guide` request that enqueues it when the guide or the embeddings model changed) |
| Skill | `/guide init`, `/guide write <topic>`, `/guide sync`, `/guide audit`, plus `guide-build.mjs` and `docs-stale.mjs` |
| Hook | A Claude Code `Stop` hook that prints one line when the session changed code a page describes |
| Data | No table. The pages are yours (`docs/guide/`), and the index is platform rows in the kit's knowledge base (`guide:member`, `guide:admin`) |

It works on its own. With the `global-search` plugin installed, guide sections also appear in ⌘K
results, through this plugin's `global-search.providers` contribution.

## Requirements

- Rocketflare kit **0.31.0** or later (platform knowledge sources, `hostFiles`, `claudeHooks`, the
  header slot and `streamChat`).
- **Embeddings**: an `EMBEDDINGS_API_KEY`, or the `[ai]` binding (Workers AI). Without one the index
  isn't built: search falls back to keywords, which finds nothing until the index exists, and admins
  see a banner on `/guide`.
- **A chat model** for Ask the Guide (the platform key, Workers AI or the organisation's own). Without
  one, Ask answers 503 and the reader and search still work.

## Install

```bash
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@<version> --subdir plugins/guide
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@<version> --subdir plugins/guide --apply
```

The first command prints the plan and stops. `--apply` installs. There is no `db:generate` step,
because the plugin has no table. Add its cron (`20 4 * * *`) to both tomls with
`pnpm provision cloudflare <env>`, or by hand.

The install seeds `docs/guide/` (a config, `VOICE.md` and four generic starter pages) and
`apps/web/src/host/guide/content.generated.ts`. From then on **they are yours**: an upgrade never
touches them and `plugin remove` leaves them in place.

## First run

1. Ask your coding agent to run **`/guide init`**. It reads your app's screens and routes, sets
   `docs/guide/guide.config.json` (name, parts, facts, screens), rewrites or replaces the starter
   pages, fact-checks them with a separate sub-agent and bumps each page's `verified` to `HEAD`.
2. `node .claude/skills/guide/scripts/guide-build.mjs` validates the guide and writes the content
   module. Commit `docs/guide/`, `apps/web/src/host/guide/` and `apps/web/public/guide/`.
3. `pnpm dev`, open `/guide`. As an admin with embeddings configured, the banner clears once the
   first `guide.sync` has run.
4. Press <kbd>?</kbd> anywhere and ask how something works.

## Keeping it in sync

Every page names the code it describes and the commit it was last checked at:

```yaml
sources: [apps/web/src/ui/pages/settings/People.tsx, apps/web/src/api/routes/invitations.ts]
verified: "2a22b5f"
```

At the end of every agent turn, the **Stop hook** runs
`docs-stale.mjs --changed --quiet --hook`. When the working tree changes a file a page lists, it
prints one line, once:

```
User guide may be stale — you changed functionality it describes. Run /guide sync to sweep it before you commit.
```

It names no files or pages, and it stays quiet until the set of stale pages changes. **`/guide
sync`** groups the changes by feature, re-checks each claim on the stale pages against the code,
rewrites only what changed (in `VOICE.md`'s register), has a separate sub-agent fact-check the
edits, proposes pages for new features, bumps `verified` and rebuilds. The gate fails while the
generated module is out of date with `docs/guide/`.

`node .claude/skills/guide/scripts/docs-stale.mjs` with no flags lists every page whose sources
changed in a commit after `verified`. It needs full git history, so it isn't part of the gate.

## Permissions and data

- Any signed-in member of an organisation reads the guide. Admin-level members (owner, admin and
  global admin) also read the admin pages. The server decides the audience from the role. The
  client never sends it.
- The index is the same for every organisation (platform documents with no tenant). Every
  organisation can read it and none can write it. Only the `guide.sync` job writes it.
- Ask the Guide is stateless. The question and the history come from the browser tab, and nothing
  is stored except the usage row and the trace. The screen hint is a route that the server maps to
  a guide page, and the route itself never reaches the model.
- Page HTML is sanitised (GitHub's allow-list). Answers render with raw HTML skipped.

## Known gaps

- **No public site yet.** The guide is only in the app, for signed-in members. A public help site
  is planned as a data source for a CMS plugin. The loader (`packages/shared/src/plugins/guide/`)
  is one pure module so a site can reuse it.
- **No screenshots.** There is no screenshot pipeline, so put hand-made images in
  `docs/guide/images/`.
- **Images are public.** `apps/web/public/guide/images/` is served as static assets without a session,
  admin pages' images included. Never show private data in one.
- The index is one per deployment: the guide can't vary per organisation.

## More

- [`CLAUDE.md`](apps/web/src/plugins/guide/CLAUDE.md): the plugin's reference.
- [Upgrade notes](docs/upgrades/): one per release.
- The kit's [plugins section](https://github.com/rocketflare-dev/rocketflare/blob/main/docs/CONCEPTS.md#16-plugins).
