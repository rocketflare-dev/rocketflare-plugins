# guide plugin

An in-app user guide about the app. **The content is the host's** (`docs/guide/`, seeded once,
never overwritten); this directory is the machinery that serves, indexes and answers from it.

- **Content → module**: `.claude/skills/guide/scripts/guide-build.mjs` validates `docs/guide/` with
  the pure loader `packages/shared/src/plugins/guide/content.ts` (zero imports — Node runs it with
  type stripping) and writes `@/host/guide/content.generated` + `apps/web/public/guide/images/`.
  `tests/config/generated.test.ts` fails the gate while they are stale. Never hand-edit the module.
- **Audience**: `content.ts` `guideViewFor(isAdmin)` is the ONLY way a route reads pages. The
  audience comes from `ctx.isAdmin` (the kit's admin-level check) or `scope.bypass`; a client never
  sends it. An admin page is a 404 for a member, everywhere (toc, page, search, citations, screens).
- **Index**: `services/sync.ts`. One platform document per page H2 section
  (`guide:member`/`guide:admin`, externalId `<path>#<heading>`), pruned per source, marker
  `guide:meta`/`bundle` written LAST. Only the `guide.sync` job writes; the cron task and the lazy
  `ensureGuideIndex` (every `/api/guide` request) only enqueue. No embedder → the job throws
  `PlatformEmbeddingsError` on purpose.
- **Ask**: `api/routes.ts` `/ask` → `streamChat` with `search_guide` only, `GUIDE_MAX_TURNS`, the
  screen as a page title from the config's `screens` map (never the raw route), and CUSTOM
  `guide.answer` with citations resolved against the reader's view.
- **Router** is built lazily (`guideRouter()`, `mounts` getter): `@/plugins/api` may still be
  loading when the server barrel imports this plugin.
- **UI**: one conversation store (`ui/lib/conversation.ts`) shared by the reader's Ask pane and the
  header slide-over (`ui/header/`); page HTML goes through `rehype-sanitize`, model answers render
  with `skipHtml`.
- **Seam copies** to drop when the kit exports them: `platformEmbeddingModel` (copy of
  `resolvePlatformEmbeddings`' rule) and `readMarker` (`allTables().documents`).

Tests: `tests/config` (loader, generated module, docs-stale + hook, global-search provider),
`tests/api/guide.test.ts` (isolated: routes, audience, sync, dense search, ask), `tests/ui`.
