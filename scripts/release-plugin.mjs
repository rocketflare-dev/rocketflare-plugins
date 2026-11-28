#!/usr/bin/env node
/**
 * Release one plugin, or a named set, each at its OWN version and tag (rocketflare-dev/rocketflare#181).
 *
 *   node scripts/release-plugin.mjs <id>@<X.Y.Z> [<id>@<X.Y.Z>]... [--date YYYY-MM-DD] [--dry-run]
 *   node scripts/release-plugin.mjs --check <id>-vX.Y.Z [<id>-vX.Y.Z]...
 *
 * For each plugin named it folds `plugins/<id>/docs/upgrades/unreleased.md` into `<X.Y.Z>.md`
 * (`version`, `previous` = that plugin's own last note, `date`), resets `unreleased.md`, stamps
 * `version` in that plugin's `rocketflare-plugin.json` and its anchor `plugin.json`, and prepends
 * one `## <id> <X.Y.Z> — <date>` section per plugin to `CHANGELOG.md`. Nothing else is touched: a
 * plugin not named keeps its version and needs no note.
 *
 * The tag is `<id>-vX.Y.Z` (`freeagent-v3.15.0`). `-v` rather than `@`, because
 * `pnpm plugin add <repo>@<ref>` splits on its last `@`. The kit's resolver (0.47.0 and later)
 * reads either form and takes the newer release of each plugin, so the last lockstep tag (3.14.0)
 * stays valid and a plugin's first own release continues its version line from there.
 *
 * `--check` is the tag gate: the manifest and the anchor carry the version, the note exists with
 * an unbroken `previous`, `unreleased.md` reads `previous: <version>`, and the changelog has the
 * section. Run it before pushing a tag.
 *
 * Repository-owned, not a copy of the kit's `release.mjs` (which still cuts lockstep releases); it
 * reuses the vendored `lib/upgrade-lib.mjs` for note parsing and version order.
 *
 * Exit 0 ok · 1 error · 2 usage.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, noteProblems, parseNote, VERSION_RE } from './lib/upgrade-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const abs = p => path.join(REPO_ROOT, p)
const read = p => readFileSync(abs(p), 'utf8')
const out = (...lines) => {
  for (const l of lines) process.stdout.write(`${l}\n`)
}
const warn = (...lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`)
}

export const USAGE = [
  'usage: node scripts/release-plugin.mjs <id>@<X.Y.Z> [<id>@<X.Y.Z>]... [--date YYYY-MM-DD] [--dry-run]',
  '       node scripts/release-plugin.mjs --check <id>-vX.Y.Z [<id>-vX.Y.Z]...',
].join('\n')

const CHANGELOG = 'CHANGELOG.md'
const MANIFEST = 'rocketflare-plugin.json'
const PLUGIN_TAG = /^([a-z][a-z0-9-]*)-v(\d+\.\d+\.\d+)$/
/** Match `"version": "x"` at the top level of a JSON file (two-space indent, so exactly one). */
const TOP_LEVEL_VERSION = /^( {2}"version":\s*)"[^"]+"/m

/** `<id>-vX.Y.Z`, the tag one plugin's own release carries. */
export const pluginTag = (id, version) => `${id}-v${version}`

/** The plugin directory for `id`, read from the manifests (`plugins/<id>` by convention). */
function pluginDir(id) {
  for (const entry of readdirSync(abs('plugins'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = `plugins/${entry.name}/${MANIFEST}`
    if (!existsSync(abs(file))) continue
    if (JSON.parse(read(file)).id === id) return `plugins/${entry.name}`
  }
  return null
}

/** The anchor `plugin.json` a manifest names, repository-relative, or null. */
function anchorOf(dir) {
  const declared = JSON.parse(read(`${dir}/${MANIFEST}`)).anchor
  return typeof declared === 'string' && declared !== '' ? `${dir}/${declared}` : null
}

/** Every `X.Y.Z.md` in a plugin's notes, oldest first. */
function releasedVersions(notesDir) {
  if (!existsSync(abs(notesDir))) return []
  return readdirSync(abs(notesDir))
    .map(f => f.replace(/\.md$/, ''))
    .filter(v => VERSION_RE.test(v))
    .sort(compareVersions)
}

const sectionHeading = (id, version) => `## ${id} ${version} — `

export function hasPluginSection(changelog, id, version) {
  const escaped = `${id} ${version}`.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  return new RegExp(`^## ${escaped} — `, 'm').test(changelog)
}

/** The first paragraph of "What changed", on one line. */
function summaryOf(body) {
  return (
    (body.split('## What changed')[1] ?? '')
      .split(/\n## /)[0]
      .trim()
      .split(/\n\s*\n/)
      .map(block => block.trim())
      .find(block => block !== '' && !block.startsWith('- '))
      ?.split('\n')
      .map(line => line.trim())
      .join(' ') ?? 'See the porting note.'
  )
}

const freshUnreleased = version => `---
version: unreleased
previous: ${version}
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

_Nothing yet. Add an entry here in the same pull request as the change — see \`README.md\` beside this
file for the fields and for what "How to apply" has to say._

## How to apply

## Conflicts to expect

## Verify
`

/** Put `section` above the newest existing `## ` section. */
function prependSection(text, section) {
  const at = text.indexOf('\n## ')
  return at === -1 ? `${text}\n${section}` : text.slice(0, at + 1) + section + text.slice(at + 1)
}

function stampVersion(file, version) {
  const text = read(file)
  const next = text.replace(TOP_LEVEL_VERSION, `$1"${version}"`)
  if (!TOP_LEVEL_VERSION.test(text)) throw new Error(`no top-level "version" to stamp in ${file}`)
  return next
}

function release(specs, { date, dryRun }) {
  const jobs = []
  for (const spec of specs) {
    const m = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(spec)
    if (!m) {
      warn(`error: '${spec}' is not <id>@<X.Y.Z>`, '', USAGE)
      return 2
    }
    const [, id, version] = m
    if (jobs.some(j => j.id === id)) {
      warn(`error: ${id} is named twice`)
      return 2
    }
    const dir = pluginDir(id)
    if (!dir) {
      warn(`error: no plugins/*/${MANIFEST} declares the id '${id}'`)
      return 1
    }
    const notesDir = `${dir}/docs/upgrades`
    const notePath = `${notesDir}/${version}.md`
    const unreleasedPath = `${notesDir}/unreleased.md`
    if (existsSync(abs(notePath))) {
      warn(`error: ${notePath} already exists`)
      return 1
    }
    if (!existsSync(abs(unreleasedPath))) {
      warn(`error: ${unreleasedPath} does not exist`)
      return 1
    }
    const unreleased = read(unreleasedPath)
    const parsed = parseNote(unreleased)
    if (!parsed) {
      warn(`error: ${unreleasedPath} has no frontmatter`)
      return 1
    }
    if (/_Nothing yet\./.test(unreleased)) {
      warn(
        `error: ${unreleasedPath} is empty — write what changed first. A plugin with no change is`,
        'not released (rocketflare-dev/rocketflare#181).'
      )
      return 1
    }
    const previous = releasedVersions(notesDir).at(-1) ?? null
    if (previous && compareVersions(version, previous) <= 0) {
      warn(`error: ${id} ${version} is not newer than its last release ${previous}`)
      return 1
    }
    const note = unreleased
      .replace(/^version: .*$/m, `version: ${version}`)
      .replace(/^previous: .*$/m, `previous: ${previous ?? 'null'}`)
      .replace(/^date: .*$/m, `date: ${date}`)
    const problems = noteProblems(note, {
      file: notePath,
      version,
      expectPrevious: previous ?? 'null',
    })
    if (problems.length > 0) {
      warn(`error: the folded note would not pass the release check:`, ...problems.map(p => `  ${p}`))
      return 1
    }
    const anchor = anchorOf(dir)
    const stamps = [`${dir}/${MANIFEST}`, ...(anchor ? [anchor] : [])].map(file => ({
      file,
      text: stampVersion(file, version),
    }))
    jobs.push({
      id,
      version,
      previous,
      notePath,
      unreleasedPath,
      note,
      stamps,
      summary: summaryOf(parsed.body),
    })
  }

  let changelog = existsSync(abs(CHANGELOG)) ? read(CHANGELOG) : '# Changelog\n'
  // Prepended in reverse so the file reads in the order the plugins were named.
  for (const j of [...jobs].reverse()) {
    changelog = prependSection(
      changelog,
      `${sectionHeading(j.id, j.version)}${date}\n\n${j.summary}\n[Porting note](${j.notePath}).\n\n`
    )
  }

  if (dryRun) {
    out('dry run — would write:')
    for (const j of jobs) {
      out(
        `  ${j.notePath}  (previous: ${j.previous ?? 'null'})`,
        `  ${j.unreleasedPath}  reset`,
        ...j.stamps.map(s => `  ${s.file}  version ${j.version}`),
        `  tag ${pluginTag(j.id, j.version)}`
      )
    }
    out(`  ${CHANGELOG}  ${jobs.length} new section(s)`)
    return 0
  }

  for (const j of jobs) {
    writeFileSync(abs(j.notePath), j.note)
    writeFileSync(abs(j.unreleasedPath), freshUnreleased(j.version))
    for (const s of j.stamps) writeFileSync(abs(s.file), s.text)
    out(
      `✔ ${j.id} ${j.version} (previous ${j.previous ?? 'null'}): ${j.notePath}, ${j.stamps.length} version file(s)`
    )
  }
  writeFileSync(abs(CHANGELOG), changelog)
  const tags = jobs.map(j => pluginTag(j.id, j.version))
  out(
    `✔ ${CHANGELOG}  ${jobs.length} section(s) prepended`,
    '',
    'Next:',
    `  node scripts/release-plugin.mjs --check ${tags.join(' ')}`,
    `  commit "Release ${jobs.map(j => `${j.id} ${j.version}`).join(', ')}", open a PR, merge it`,
    '  then tag the merge commit and push each tag ON ITS OWN (GitHub starts no workflow for a',
    '  push of more than three tags at once):',
    ...tags.map(t => `    git tag ${t} <merge-sha> && git push origin ${t}`)
  )
  return 0
}

export function checkTags(tags) {
  const problems = []
  const changelog = existsSync(abs(CHANGELOG)) ? read(CHANGELOG) : ''
  for (const tag of tags) {
    const m = PLUGIN_TAG.exec(tag)
    if (!m) {
      problems.push(`'${tag}' is not <id>-vX.Y.Z`)
      continue
    }
    const [, id, version] = m
    const dir = pluginDir(id)
    if (!dir) {
      problems.push(`${tag}: no plugin declares the id '${id}'`)
      continue
    }
    for (const file of [`${dir}/${MANIFEST}`, anchorOf(dir)].filter(Boolean)) {
      const declared = JSON.parse(read(file)).version
      if (declared !== version)
        problems.push(`${tag}: ${file} version is ${declared}, the tag is ${version}`)
    }
    const notesDir = `${dir}/docs/upgrades`
    const versions = releasedVersions(notesDir)
    const at = versions.indexOf(version)
    if (at === -1) {
      problems.push(`${tag}: ${notesDir}/${version}.md does not exist`)
    } else {
      problems.push(
        ...noteProblems(read(`${notesDir}/${version}.md`), {
          file: `${notesDir}/${version}.md`,
          version,
          expectPrevious: versions[at - 1] ?? 'null',
        }).map(p => `${tag}: ${p}`)
      )
      if (at !== versions.length - 1)
        problems.push(`${tag}: ${notesDir} has a newer note (${versions.at(-1)})`)
    }
    const unreleased = existsSync(abs(`${notesDir}/unreleased.md`))
      ? read(`${notesDir}/unreleased.md`)
      : ''
    if (!unreleased.includes(`previous: ${version}`))
      problems.push(`${tag}: ${notesDir}/unreleased.md should read 'previous: ${version}'`)
    if (!hasPluginSection(changelog, id, version))
      problems.push(`${tag}: ${CHANGELOG} has no '${sectionHeading(id, version)}…' section`)
  }
  return problems
}

function main(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    out(USAGE)
    return argv.length === 0 ? 2 : 0
  }
  if (argv[0] === '--check') {
    const tags = argv.slice(1)
    if (tags.length === 0) {
      warn('error: --check needs at least one <id>-vX.Y.Z tag', '', USAGE)
      return 2
    }
    const problems = checkTags(tags)
    if (problems.length > 0) {
      warn('release check failed:', ...problems.map(p => `  ✖ ${p}`))
      return 1
    }
    out(`release check ok — ${tags.join(', ')}`)
    return 0
  }
  let date = new Date().toISOString().slice(0, 10)
  let dryRun = false
  const specs = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = argv[++i]
    else if (argv[i] === '--dry-run') dryRun = true
    else if (argv[i].startsWith('-')) {
      warn(`error: unknown option '${argv[i]}'`, '', USAGE)
      return 2
    } else specs.push(argv[i])
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    warn('error: --date needs YYYY-MM-DD', '', USAGE)
    return 2
  }
  if (specs.length === 0) {
    warn('error: name at least one <id>@<X.Y.Z>', '', USAGE)
    return 2
  }
  return release(specs, { date, dryRun })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    warn(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
