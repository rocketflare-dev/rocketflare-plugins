#!/usr/bin/env node
/**
 * Build the user guide: validate `docs/guide/` and write what the app ships.
 *
 *   node .claude/skills/guide/scripts/guide-build.mjs           # validate, then write
 *   node .claude/skills/guide/scripts/guide-build.mjs --check   # validate, write nothing; exit 1 if stale
 *
 * Validates the config, every page's frontmatter, its facts, its links (to a real page and a real
 * heading, and never from a member page to an admin one), its headings and its images (SVGs
 * against an allow-list), and fails with one line per problem. Then writes:
 *
 * - `apps/web/src/host/guide/content.generated.ts` — the whole guide, deterministic (no timestamp),
 *   imported by the plugin as `@/host/guide/content.generated`;
 * - `apps/web/public/guide/images/` — a mirror of `docs/guide/images/` (served as static assets).
 *
 * Dependency-free, Node >= 24. Exit 0 ok · 1 problems found (or stale, with --check) · 2 usage.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { flagsOf, loadContentModule, repoRoot } from './lib.mjs'

const flags = flagsOf()
const known = new Set(['--check', '--quiet'])
const unknown = flags.filter(f => !known.has(f))
if (unknown.length > 0) {
  console.error(`guide-build: unknown flag(s) ${unknown.join(', ')} — use --check, --quiet, --root <dir>`)
  process.exit(2)
}
const check = flags.includes('--check')
const quiet = flags.includes('--quiet')
const root = repoRoot()

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

/** Every file under `dir`, POSIX paths relative to it, sorted; dot entries skipped. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out.sort()
}

/** Are two directories' files byte-identical, as sets? */
function sameTree(a, b) {
  const fa = walk(a)
  const fb = walk(b)
  if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false
  return fa.every(f => readFileSync(path.join(a, f)).equals(readFileSync(path.join(b, f))))
}

async function main() {
  const content = await loadContentModule()
  const contentDir = path.join(root, content.GUIDE_CONTENT_DIR)
  if (!existsSync(contentDir)) {
    console.error(`guide-build: ${content.GUIDE_CONTENT_DIR}/ does not exist — run /guide init`)
    return 1
  }
  const imagesDir = path.join(contentDir, content.GUIDE_IMAGES_DIR)
  const all = walk(contentDir)
  const files = all
    .filter(f => !f.startsWith(`${content.GUIDE_IMAGES_DIR}/`))
    .filter(f => f.endsWith('.md') || f === content.GUIDE_CONFIG_FILE)
    .map(f => ({ path: f, raw: readFileSync(path.join(contentDir, f), 'utf8') }))
  const images = walk(imagesDir)
    .filter(f => !f.includes('/'))
    .map(name => ({
      name,
      svg: name.toLowerCase().endsWith('.svg') ? readFileSync(path.join(imagesDir, name), 'utf8') : undefined,
    }))

  const built = content.buildGuideBundle({ files, images, hash: sha256 })
  if (!built.bundle) {
    console.error(`guide-build: ${built.problems.length} problem(s) in ${content.GUIDE_CONTENT_DIR}/:`)
    for (const p of built.problems) {
      const where = p.file === '.' ? content.GUIDE_CONTENT_DIR : `${content.GUIDE_CONTENT_DIR}/${p.file}`
      console.error(`  ${where}: ${p.message}`)
    }
    return 1
  }
  const bundle = built.bundle
  const moduleText = content.renderGuideModule(bundle)
  const moduleFile = path.join(root, content.GUIDE_GENERATED_MODULE)
  const publicDir = path.join(root, content.GUIDE_PUBLIC_IMAGES_DIR)
  const current = existsSync(moduleFile) ? readFileSync(moduleFile, 'utf8') : null
  const moduleStale = current !== moduleText
  const imagesStale = !sameTree(imagesDir, publicDir)

  if (check) {
    if (moduleStale || imagesStale) {
      const what = [moduleStale && content.GUIDE_GENERATED_MODULE, imagesStale && `${content.GUIDE_PUBLIC_IMAGES_DIR}/`]
        .filter(Boolean)
        .join(' and ')
      console.error(`guide-build: ${what} no longer match ${content.GUIDE_CONTENT_DIR}/ — run \`${content.GUIDE_BUILD_COMMAND}\``)
      return 1
    }
    if (!quiet) console.log(`guide-build: up to date — ${bundle.pages.length} page(s), bundle ${bundle.hash.slice(0, 12)}`)
    return 0
  }

  if (moduleStale) {
    mkdirSync(path.dirname(moduleFile), { recursive: true })
    writeFileSync(moduleFile, moduleText)
  }
  if (imagesStale) {
    rmSync(publicDir, { recursive: true, force: true })
    if (existsSync(imagesDir) && walk(imagesDir).length > 0) {
      mkdirSync(publicDir, { recursive: true })
      for (const f of walk(imagesDir)) cpSync(path.join(imagesDir, f), path.join(publicDir, f))
    }
  }
  if (!quiet) {
    const sections = bundle.pages.reduce((n, p) => n + p.sections.length, 0)
    const wrote = [moduleStale && content.GUIDE_GENERATED_MODULE, imagesStale && `${content.GUIDE_PUBLIC_IMAGES_DIR}/`].filter(Boolean)
    console.log(
      `guide-build: ${bundle.pages.length} page(s), ${sections} section(s), ${bundle.images.length} image(s), bundle ${bundle.hash.slice(0, 12)} — ${
        wrote.length ? `wrote ${wrote.join(' and ')}` : 'already up to date'
      }`
    )
  }
  return 0
}

main().then(
  code => process.exit(code),
  err => {
    console.error(`guide-build: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
)
