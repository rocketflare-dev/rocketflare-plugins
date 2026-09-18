# rocketflare-plugins

The first-party plugins for [Rocketflare](https://github.com/rocketflare-dev/rocketflare).

**These are not npm packages.** A Rocketflare plugin is a git repository *copied into* your app —
exactly like the kit itself — so its code lands as ordinary source you can read, debug and edit,
translated into your app's own vocabulary on the way in. The price is that an upgrade is a patch
rather than a version bump, which the kit's tooling already knows how to do.

## The plugins

| Plugin | Subdir | What it adds |
|---|---|---|
| **analytics** | `plugins/analytics` | Dashboards (`analytics_pages`), four tenant-scoped cubes served by drizzle-cube at `/cubejs-api` and `/mcp`, one fact table rebuilt hourly, the `Dashboard` and `Analytics` CASL subjects, three UI routes and three CLI commands. Requires kit `>=0.6.1 <1.0.0`. |

## Installing one

```bash
# Read the plan first — it always prints and stops.
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@1.0.2 --subdir plugins/analytics
# Then install it.
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git@1.0.2 --subdir plugins/analytics --apply
# The HOST generates the migration. Always.
pnpm db:generate --name plugin-analytics-1.0.2 && pnpm db:migrate
```

`--subdir` is what tells `pnpm plugin add` which plugin in this repository you mean; each plugin
also records its own subdirectory in its `rocketflare-plugin.json`, so `pnpm plugin upgrade
<id>` later needs no flag.

Installing a plugin gives it full Worker and database access — it is as trusting as merging a pull
request — which is why every command prints its plan and waits for `--apply`.

## Layout

```
rocketflare-plugins/
  package.json                    the ONE version for the whole repository
  CHANGELOG.md                    the human index; the porting notes live per plugin
  scripts/                        the kit's release tooling, ONE copy (see below)
  .github/workflows/ci.yml        one job per plugin, calling the kit's reusable workflow
  plugins/<id>/
    rocketflare-plugin.json       what makes a directory a plugin
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

## One version, one tag

Every plugin here ships at the repository's version and is tagged plain `X.Y.Z` — no tag prefixes,
no per-plugin version namespacing. A release cuts every plugin at once, whether or not its own
files changed.

The trade is deliberate. Independent versions would mean prefixed tags (`analytics-v1.3.0`), a
resolver to match them, and a matrix of which plugin versions have ever been proved against each
other. Lockstep costs an occasional no-op version bump and buys one answer to "which release am I
on" and one CI run that proves the whole set against a kit ref.

## The shared tooling

`scripts/` holds the kit's release machinery — `release.mjs`, `release-check.mjs` and the five
`lib/*.mjs` they import — in **one copy**, at the repository root.

That location is load-bearing. It sits **outside every `plugins/<id>/` directory**, so
`classifyPluginFile` never sees these files and they cannot leak into a host app by construction —
where before, each plugin repository vendored its own copy and nothing kept the copies in step.
They are maintained in the kit (`rocketflare-dev/rocketflare`, `scripts/`) and copied here; when
the kit's move, copy them again rather than editing them in place.

## Releasing

`node scripts/release.mjs X.Y.Z` — the kit's own release script. It detects a
`rocketflare-plugin.json` with no `.rocketflare.json`, stamps that manifest's version and
`package.json`, folds `docs/upgrades/unreleased.md` into `docs/upgrades/X.Y.Z.md` and prepends the
`CHANGELOG.md` section.

**Released history is never rewritten.** Every app pins a commit of this repository; a force-push
to a released tag orphans them.

## CI

`.github/workflows/ci.yml` calls the kit's reusable `plugin-ci.yml` **once for the whole
repository**, passing `plugin_subdirs`. For each plugin it reads that plugin's `requires.kit`,
resolves the **oldest and the newest** kit release inside the range, and for each clones that kit,
installs this checkout into it, generates and applies the migrations the host owns, and runs the
kit's whole gate — every plugin against every kit version its OWN range admits, off one
include-matrix. Both ends of the range rather than a midpoint: the floor an adopter may still be
on, and the ceiling the kit has just reached.

The kit also dispatches `kit-released` here on every tag it cuts, and `ci.yml` listens for it: that
run proves the plugins against the ref just released rather than re-resolving the same range, so a
kit that moves under a plugin is discovered on the day rather than whenever somebody next pushes.

Failing at the FLOOR means the plugin has started using something the kit only gained later — raise
`requires.kit` and release. Failing at the CEILING means the kit has moved under it: port the
plugin and widen the range.

## Adding a plugin to this repository

Create `plugins/<id>/` with a `rocketflare-plugin.json` (`id`, `version`, `repo` pointing here,
`subdir: "plugins/<id>"`, `requires.kit`), mirror the host tree beneath it, add a row to the table
above and a line to the `plugin_subdirs` array in `ci.yml`. Namespace everything with the id — tables `<id>_*`, job types
`<id>.x`, query-key roots `<id>:…`, the API prefix `/api/<id>` — because two plugins have to be
able to live in one app.

## History

`analytics` was released from `rocketflare-dev/rocketflare-plugin-analytics` up to and including
`1.0.2`. That repository is unchanged and its tags still install; this one continues from there.

## Licence

MIT, the same as the kit. See `LICENSE`.
