/**
 * The pure half of `docs-stale.mjs`: which guide pages describe code that has moved since somebody
 * last checked them. Everything git-shaped goes through the `git` seam, so the rules run against
 * a fake in a test as well as the real repository.
 *
 * A page declares, in its frontmatter, the code it describes and the commit it was last checked at:
 *
 *     sources: [apps/web/src/ui/pages/members/**, apps/web/src/api/routes/members.ts]
 *     verified: 2a22b5f
 *
 * A page is STALE when a file matching `sources` changed after `verified`. Staleness is reported,
 * never fatal. STRUCTURAL errors are: a page without `sources` / `verified`, a glob that matches
 * nothing (the code it describes has gone), a `verified` sha git does not know.
 *
 * ⚠️ **A commit that touches the page itself counts as a check.** `verified` cannot name the commit
 * it is written in, so the normal flow — change the code, run /guide sync, bump `verified` to HEAD,
 * commit both — would otherwise leave the page stale the moment it lands. In `--changed` mode the
 * working tree counts the same way: a page being edited alongside the code is assumed to be the sync.
 */
import path from 'node:path'

/** Repo-relative prefix of the guide's pages. */
export const GUIDE_PREFIX = 'docs/guide/'

/**
 * @typedef {{ path: string, added: number | null, deleted: number | null }} FileChange
 * @typedef {{ sha: string, files: FileChange[] }} CommitChanges
 * @typedef {{
 *   listFiles(): string[],
 *   readFile(file: string): string,
 *   resolveCommit(ref: string): string | null,
 *   commitsSince(sha: string): CommitChanges[],
 *   workingChanges(): FileChange[],
 * }} DocsGit
 * @typedef {{ doc: string, verified: string, files: FileChange[] }} StaleDoc
 * @typedef {{ doc: string, message: string }} DocError
 * @typedef {{ mode: 'history' | 'changed', checked: number, stale: StaleDoc[], errors: DocError[] }} DocsStaleReport
 */

const matchesAny = (file, globs) => globs.some(g => path.matchesGlob(file, g))

/** Sum numstat rows per path, keeping null (binary / untracked) sticky. */
function mergeChanges(changes) {
  const byPath = new Map()
  for (const c of changes) {
    const prev = byPath.get(c.path)
    if (!prev) {
      byPath.set(c.path, { ...c })
      continue
    }
    prev.added = prev.added === null || c.added === null ? null : prev.added + c.added
    prev.deleted = prev.deleted === null || c.deleted === null ? null : prev.deleted + c.deleted
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * @param {DocsGit} git
 * @param {{ changed?: boolean, content: { isGuidePagePath(rel: string): boolean, parseFrontmatter(raw: string): { data: Record<string, unknown> } } }} opts
 * @returns {DocsStaleReport}
 */
export function checkDocs(git, opts) {
  const files = git.listFiles()
  const docs = files
    .filter(f => f.startsWith(GUIDE_PREFIX) && opts.content.isGuidePagePath(f.slice(GUIDE_PREFIX.length)))
    .sort()
  const errors = []
  const stale = []
  const working = opts.changed ? git.workingChanges() : []
  const workingPaths = new Set(working.map(c => c.path))
  const historyCache = new Map()

  for (const doc of docs) {
    let data
    try {
      data = opts.content.parseFrontmatter(git.readFile(doc)).data
    } catch (err) {
      errors.push({ doc, message: err instanceof Error ? err.message : String(err) })
      continue
    }
    const sources = data.sources
    const verified = typeof data.verified === 'number' ? String(data.verified) : data.verified
    const bad = []
    if (!Array.isArray(sources) || sources.length === 0 || !sources.every(s => typeof s === 'string' && s))
      bad.push('sources')
    if (typeof verified !== 'string' || verified.length < 7) bad.push('verified')
    if (bad.length > 0) {
      errors.push({ doc, message: `bad or missing ${bad.join(', ')}` })
      continue
    }
    for (const glob of sources) {
      if (!files.some(f => path.matchesGlob(f, glob))) {
        errors.push({ doc, message: `source glob matches no files: ${glob}` })
      }
    }
    const full = git.resolveCommit(verified)
    if (!full) {
      errors.push({ doc, message: `verified sha is not a known commit: ${verified}` })
      continue
    }

    let changed
    if (opts.changed) {
      // The page is being edited alongside the code — that edit is the sync.
      if (workingPaths.has(doc)) continue
      changed = working.filter(c => matchesAny(c.path, sources))
    } else {
      let commits = historyCache.get(full)
      if (!commits) {
        commits = git.commitsSince(full)
        historyCache.set(full, commits)
      }
      changed = commits
        .filter(commit => !commit.files.some(f => f.path === doc))
        .flatMap(commit => commit.files.filter(f => matchesAny(f.path, sources)))
    }
    if (changed.length > 0) stale.push({ doc, verified, files: mergeChanges(changed) })
  }
  return { mode: opts.changed ? 'changed' : 'history', checked: docs.length, stale, errors }
}

function stat(c) {
  if (c.added === null || c.deleted === null) return 'new/binary'
  return `+${c.added} -${c.deleted}`
}

/** Human output for a person at a terminal. Empty when there is nothing to say and `quiet`. */
export function formatReport(report, { quiet = false, label = 'User guide' } = {}) {
  const { stale, errors } = report
  if (quiet && stale.length === 0 && errors.length === 0) return ''
  const lines = []
  if (report.mode === 'changed' && stale.length > 0) {
    lines.push(`${label}: these pages describe code you changed — run /guide sync before committing:`)
    for (const s of stale) for (const f of s.files) lines.push(`  ${s.doc} ← ${f.path} (${stat(f)})`)
  } else if (stale.length > 0) {
    lines.push(`${label}: ${stale.length} stale page(s) — their sources changed after \`verified\`:`)
    for (const s of stale) {
      lines.push('', `${s.doc}  (verified ${s.verified})`)
      const width = Math.max(...s.files.map(f => f.path.length))
      for (const f of s.files) lines.push(`  ${f.path.padEnd(width)} | ${stat(f)}`)
    }
    lines.push('', 'Run /guide sync to check them against the code and bump `verified`.')
  }
  if (errors.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`${errors.length} structural error(s):`)
    for (const e of errors) lines.push(`  ${e.doc}: ${e.message}`)
  }
  if (lines.length === 0) lines.push(`${label}: ${report.checked} page(s) checked, none stale.`)
  return lines.join('\n')
}

/** Structural errors fail; staleness alone does not. */
export function exitCodeFor(report) {
  return report.errors.length > 0 ? 1 : 0
}

/** The `verified` the plugin's starter pages ship with: no commit, so `/guide init` must check them. */
export const SEED_VERIFIED = '0000000'

const ANSI = { bold: '\u001b[1m', cyan: '\u001b[36m', yellow: '\u001b[33m', reset: '\u001b[0m' }

/**
 * The Stop hook's ONE line for the person: no file, no page, the guide's own name, never the word
 * "docs". Null when there is nothing to say. `color` wraps the label in bold cyan and the command
 * in yellow — off by default, because Claude Code does not document ANSI in `systemMessage`.
 */
export function hookMessage(report, { label = 'User guide', color = false } = {}) {
  const name = color ? `${ANSI.bold}${ANSI.cyan}${label}${ANSI.reset}` : label
  const cmd = color ? `${ANSI.yellow}/guide sync${ANSI.reset}` : '/guide sync'
  if (report.stale.length > 0) {
    return `${name} may be stale — you changed functionality it describes. Run ${cmd} to sweep it before you commit.`
  }
  if (report.errors.length > 0 && report.errors.every(e => e.message.endsWith(`: ${SEED_VERIFIED}`))) {
    return `${name} still holds the starter pages nobody has checked against this app. Run ${color ? `${ANSI.yellow}/guide init${ANSI.reset}` : '/guide init'} to write it from the code.`
  }
  if (report.errors.length > 0) {
    return `${name} has pages that no longer match the repository. Run ${cmd} to fix them before you commit.`
  }
  return null
}

/**
 * What the hook remembers between runs: the set it last nudged about. A Stop hook fires after
 * every turn, so the same nudge would otherwise repeat until the sweep is done.
 */
export function hookFingerprint(report) {
  const stale = report.stale.map(s => s.doc).sort()
  const errors = report.errors.map(e => `${e.doc}: ${e.message}`).sort()
  if (stale.length === 0 && errors.length === 0) return null
  return JSON.stringify({ stale, errors })
}

/** Parse `git log --numstat --format=@@%H` output into commits. */
export function parseNumstatLog(out) {
  const commits = []
  let current = null
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      current = { sha: line.slice(2).trim(), files: [] }
      commits.push(current)
      continue
    }
    const row = parseNumstatLine(line)
    if (row && current) current.files.push(row)
  }
  return commits
}

/** One `added<TAB>deleted<TAB>path` row; `-` counts mean binary. */
export function parseNumstatLine(line) {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
  if (!m) return null
  return {
    path: m[3],
    added: m[1] === '-' ? null : Number(m[1]),
    deleted: m[2] === '-' ? null : Number(m[2]),
  }
}
