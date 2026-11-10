---
name: guide
description: Write and maintain this app's in-app user guide (docs/guide/) — the pages people read at /guide and that "Ask the Guide" answers from. Use when the Stop hook says the user guide may be stale ("Run /guide sync"), after changing a screen, flow, role rule or limit a guide page describes, when asked to write, update, check or audit the user guide or help pages, or on first install (`/guide init`). `/guide init` writes the guide from the code; `/guide write <topic>` adds a page; `/guide sync` fixes the stale set; `/guide audit` sweeps every page and proposes edits.
---

# guide

The user guide is markdown in `docs/guide/` — **yours**, seeded once by the plugin and never
overwritten by an upgrade. `guide.config.json` holds its parts, sections, callout labels, facts and
the screen → page map; each page is `docs/guide/<part>/<slug>.md` with frontmatter:

```yaml
title: Inviting people
part: start            # a part id from guide.config.json
section: access        # a section id of that part
order: 2               # position in the section
audience: member       # member | admin — an admin page is invisible (404) to members
summary: One sentence, shown in the contents and search.
sources: [apps/web/src/ui/pages/settings/People.tsx, apps/web/src/api/routes/invitations.ts]
verified: "2a22b5f"    # the commit this page was last checked against its sources
```

**Build it** after any change: `node .claude/skills/guide/scripts/guide-build.mjs`. It validates
everything (config, frontmatter, facts, links, headings, images) and writes
`apps/web/src/host/guide/content.generated.ts` and `apps/web/public/guide/images/`. Commit both
with the pages; a config test fails the gate while they are stale. Deployed, the server indexes
each page section into the knowledge base (semantic search needs embeddings configured).

**Staleness**: `node .claude/skills/guide/scripts/docs-stale.mjs` lists the pages whose `sources`
changed after `verified` (a commit that touches the page counts as a check). The Stop hook runs it
with `--changed --quiet --hook` and shows one line when the working tree changed code a page
describes.

Read `docs/guide/VOICE.md` before writing a word.

## The rules

- **The code is the truth.** Read the screen's component and the route, not a comment or an issue.
- **Describe what the app does today**, for the person using it. No internals (table names, job
  names), no line numbers, no plans written as if built.
- **Screen labels exactly as rendered**, in bold. Check the JSX, not your memory.
- **Never type a number the code owns.** `{{fact:key}}`, with the value in `facts` in
  `guide.config.json` — and check that value against the constant every time you touch the page.
- **Who sees what.** An admin-only screen or action goes on an `audience: admin` page; a member page
  never links to one (the build refuses). Read the permission check (guard, CASL rule) before you
  write "anyone can".
- **Keep `sources` globs coarse** (a screen's directory, its route file), and never inventory a
  directory in prose.
- **Never polish prose the change did not touch.**

## `/guide init` (first run)

The plugin seeds a config and four generic starter pages (`verified: "0000000"`: nobody has checked
them against this app, and `docs-stale` reports them until someone does).

1. **Learn the app.** Read the UI routes and the nav (`apps/web/src/ui/`, `apps/web/src/plugins/*/ui/`),
   the main screens and their API routes. List the jobs a member does and the jobs an admin does.
2. **Set the config**: `label`, `appName`, the parts and sections that match those jobs, the
   `screens` map (route prefix → the page that explains it — Ask the Guide uses it for "what do I do
   here?"), and the facts the pages will need.
3. **Fix or replace each starter page** against this app's real screens, and write one page per
   job (see `write`). Delete starter pages that do not apply.
4. **Fact-check with a SEPARATE sub-agent**: give it the pages and the source files, ask it to
   verify every sentence against the code. Fix what it finds.
5. **Bump `verified`** on every page to `git rev-parse --short HEAD` — quoted (`verified: "1060038"`)
   when it is all digits, which YAML would read as a number.
6. **Build** (`guide-build.mjs`) until it prints no problem, then `pnpm gate`.

## `/guide write <topic>`

1. Find the code: the screen, its route, its permission checks, the constants it uses.
2. Pick the part and section (add one to the config if none fits) and the audience.
3. Write the page in the `VOICE.md` shape, with `sources` naming that code.
4. Fact-check with a separate sub-agent, bump `verified`, link it from a related page, build.

## `/guide sync` (incremental — what the hook asks for)

1. **Gather.** `node .claude/skills/guide/scripts/docs-stale.mjs --json` →
   `{ stale: [{ doc, verified, files }], errors }`, plus `--changed --json` for the working tree.
   Fix `errors` first: a missing field, a glob that matches nothing (point it at where the code
   went) or an unknown sha.
2. **Group the changes by FEATURE**, not by file: one screen or flow may span a component, a route
   and a shared schema. Read `git diff <verified>..HEAD -- <files>` plus the working tree for each.
3. **List every claim** in the stale pages that the diff touches: labels, steps and their order,
   who sees what, limits and messages.
4. **Check each claim against the code as it is now.** Leave a right claim alone.
5. **Rewrite only the claims that changed**, in the page's register (`VOICE.md`). Update a `facts`
   value whose constant moved.
6. **Fact-check with a SEPARATE sub-agent** (the edited pages, the diff, a file allowlist; verify
   every changed sentence against the code). Fix what it finds.
7. **Propose new pages** for a feature the diff adds that no page describes — ask before writing
   more than one.
8. **Bump `verified`** to `git rev-parse --short HEAD` on every page you checked (quoted when all
   digits).
9. **Build** (`guide-build.mjs`), re-run `docs-stale.mjs` until clean, then `pnpm gate`.

Report the pages checked, each claim changed (page, old, new, and the code that proves it), and the
pages proposed.

## `/guide audit` (whole guide)

A report plus proposed edits — never silent rewrites; apply only after the user agrees.

1. **Drift**: check every page against the code regardless of `verified` — one sub-agent per part
   with a file allowlist, a separate agent spot-checking their findings. Flag behaviour that changed
   outside the declared `sources` (propose wider globs).
2. **Gaps**: screens and admin actions no page describes; `screens` entries that point at the wrong
   page.
3. **Repetition**: the same fact in two pages → one owner, the other links to it.
4. **Report** grouped by page.

## Tools

| command | what it does |
|---|---|
| `node .claude/skills/guide/scripts/guide-build.mjs [--check]` | validate `docs/guide/`, write the content module + images (`--check`: write nothing, exit 1 if stale) |
| `node .claude/skills/guide/scripts/docs-stale.mjs [--changed] [--json] [--quiet]` | stale pages + structural errors; non-zero only on errors |
| `… docs-stale.mjs --changed --quiet --hook [--color]` | the Stop hook: one `systemMessage` line, only when the stale set changed |
