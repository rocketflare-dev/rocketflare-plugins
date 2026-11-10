#!/usr/bin/env node
/**
 * Which user-guide pages describe code that changed after their `verified` commit. The rules are
 * `docs-stale-lib.mjs`; this file is the git adapter and the CLI. Dependency-free, Node >= 24.
 *
 *   node .claude/skills/guide/scripts/docs-stale.mjs              # history: commits in verified..HEAD
 *   node .claude/skills/guide/scripts/docs-stale.mjs --changed    # only the working tree vs HEAD
 *   node .claude/skills/guide/scripts/docs-stale.mjs --json       # machine-readable, for /guide sync
 *   node .claude/skills/guide/scripts/docs-stale.mjs --quiet      # print nothing when clean
 *   node .claude/skills/guide/scripts/docs-stale.mjs --changed --quiet --hook   # the Stop hook
 *
 * `--hook` prints at most ONE line, `{"systemMessage": "…"}` — the documented way for a Stop hook
 * to show the person a message without blocking — naming no file and no page, and only when the
 * set of stale pages differs from the one it last nudged about (remembered in
 * `.claude/skills/guide/.state.json`, git-ignored). Never `additionalContext`: that would make the
 * agent continue the turn, and a stale page would re-trigger it on every stop. Always exit 0.
 * `--color` colours the line (the guide's label bold cyan, `/guide sync` yellow); `NO_COLOR` or
 * `--no-color` turns it back off. `--root <dir>` checks another repository.
 *
 * Exit 1 on a structural error; staleness alone exits 0. Needs full history (not in the gate).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDocs, exitCodeFor, formatReport, hookFingerprint, hookMessage, parseNumstatLine, parseNumstatLog } from './docs-stale-lib.mjs'
import { flagsOf, loadContentModule, repoRoot } from './lib.mjs'

/** `GUIDE_STATE_FILE` moves it (the plugin's tests do, so they never touch a checkout's real one). */
const STATE_FILE =
  process.env.GUIDE_STATE_FILE ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.state.json')

const flags = new Set(flagsOf())
const hook = flags.has('--hook')
const known = new Set(['--changed', '--json', '--quiet', '--hook', '--color', '--no-color'])
const unknown = [...flags].filter(f => !known.has(f))

function realGit(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const lines = out => out.split('\n').filter(Boolean)
  return {
    // The index can still list a file deleted on disk (an unstaged delete): never read one.
    listFiles: () => lines(git('ls-files', '--cached', '--others', '--exclude-standard')).filter(f => existsSync(path.join(root, f))),
    readFile: file => readFileSync(path.join(root, file), 'utf8'),
    resolveCommit: ref => {
      try {
        return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim() || null
      } catch {
        return null
      }
    },
    commitsSince: sha => parseNumstatLog(git('log', '--no-renames', '--numstat', '--format=@@%H', `${sha}..HEAD`)),
    workingChanges: () => {
      const tracked = lines(git('diff', '--no-renames', '--numstat', 'HEAD')).map(parseNumstatLine).filter(c => c !== null)
      const untracked = lines(git('ls-files', '--others', '--exclude-standard')).map(p => ({ path: p, added: null, deleted: null }))
      return [...tracked, ...untracked]
    },
  }
}

/** The guide's name from its config — the nudge never says "docs". */
function guideLabel(root, content) {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, content.GUIDE_CONTENT_DIR, content.GUIDE_CONFIG_FILE), 'utf8'))
    return typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : content.GUIDE_DEFAULT_LABEL
  } catch {
    return content.GUIDE_DEFAULT_LABEL
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function main() {
  if (unknown.length > 0) {
    if (hook) return 0
    console.error(`docs-stale: unknown flag(s) ${unknown.join(', ')} — use ${[...known].join(', ')}, --root <dir>`)
    return 2
  }
  const root = repoRoot()
  const content = await loadContentModule()
  const report = checkDocs(realGit(root), { changed: flags.has('--changed'), content })
  const label = guideLabel(root, content)

  if (hook) {
    const fingerprint = hookFingerprint(report)
    const key = root
    const state = readState()
    if (fingerprint === null) {
      // Clean: forget the last nudge, so the next stale set nudges again.
      if (state[key] !== undefined) {
        delete state[key]
        if (Object.keys(state).length === 0) rmSync(STATE_FILE, { force: true })
        else writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
      }
      return 0
    }
    if (state[key] === fingerprint) return 0
    const color = flags.has('--color') && !flags.has('--no-color') && !process.env.NO_COLOR
    const message = hookMessage(report, { label, color })
    if (message) process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`)
    state[key] = fingerprint
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
    return 0
  }
  if (flags.has('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const text = formatReport(report, { quiet: flags.has('--quiet'), label })
    if (text) console.log(text)
  }
  return exitCodeFor(report)
}

main().then(
  code => process.exit(code),
  err => {
    // A reminder, never a gate: the hook swallows its own failure.
    if (hook) process.exit(0)
    console.error(`docs-stale: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
)
