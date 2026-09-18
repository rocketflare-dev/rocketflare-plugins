# Release notes, written for an agent

One file per release of this plugin, `X.Y.Z.md`, plus `unreleased.md`, which collects entries
between releases. `CHANGELOG.md` at the repository root is the human index. These files are the
porting instructions: `pnpm plugin upgrade web-knowledge` drives the kit's `scripts/upgrade.mjs`,
which reads their frontmatter.

## The shape

Frontmatter comes first, then four fixed headings in this order: **What changed**, **How to
apply**, **Conflicts to expect**, **Verify**.

| Field | Means |
|---|---|
| `version` · `previous` | This release and the one before it. `previous: null` appears only on the first release. `plugin upgrade` walks this chain, so a gap is permanent |
| `date` | `YYYY-MM-DD` |
| `breaking` | Does an adopter have to change their own code? |
| `migrations` | **Descriptions of the schema change, never file names.** The host generates the DDL with `pnpm db:generate`; this plugin never ships a migration |
| `areas` · `touches_surfaces` · `requires_surfaces` | Where the change lands |
| `manual` | Is there a step no tool can do? |

## The rules

- **Released history is never rewritten.** Every app pins a commit of this repository.
- **A behaviour change adds an entry to `unreleased.md` in the same commit.**
  `node scripts/release.mjs X.Y.Z` folds it into `X.Y.Z.md`.
- **Never rename anything across releases**, whether a table, a column, a provider id or a tool
  name. Expand and contract instead.
