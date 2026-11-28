#!/usr/bin/env node
/**
 * A Claude Code `PreToolUse` hook: when a `git commit` changes the root `package.json` version —
 * which is what a kit release commit does — or, in the plugins monorepo, a plugin manifest's
 * version (each plugin releases on its own), remind Claude to update the website (rocketflare-www)
 * once the tag is out. The changelog on rocketflare.dev is synced by hand from the GitHub Releases,
 * and a release that never reaches it is invisible to everybody reading the site.
 *
 * It runs in the kit (`.rocketflare.json` with no `app` block) and in the plugins monorepo (a
 * `plugins/<id>/rocketflare-plugin.json`), and exits silently anywhere else — an app's version is
 * its own business. The plugins repository carries a copy of this file and `lib/nudge-lib.mjs`.
 *
 * Advisory: it writes `additionalContext` (what Claude reads) and exits 0. Never fails a commit on
 * its own error. `ROCKETFLARE_WWW_DIR` names the site checkout in the reminder.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitsAll, hookJson, isGitCommit, siteReminder, versionChange } from './lib/nudge-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** `kit`, `plugins` or `null` (anything else — an app, or not ours at all). */
function repoKind() {
  const manifest = path.join(REPO_ROOT, '.rocketflare.json')
  if (existsSync(manifest)) {
    return JSON.parse(readFileSync(manifest, 'utf8')).app == null ? 'kit' : null
  }
  const plugins = path.join(REPO_ROOT, 'plugins')
  if (!existsSync(plugins)) return null
  const hasPlugin = readdirSync(plugins, { withFileTypes: true }).some(
    d => d.isDirectory() && existsSync(path.join(plugins, d.name, 'rocketflare-plugin.json'))
  )
  return hasPlugin ? 'plugins' : null
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function main() {
  const payload = (() => {
    try {
      return JSON.parse(readStdin())
    } catch {
      return {}
    }
  })()
  const command = payload?.tool_input?.command ?? ''
  if (payload.tool_name !== 'Bash' || !isGitCommit(command)) return
  const kind = repoKind()
  if (!kind) return

  // `-a` commits the working tree's tracked changes; otherwise only what is staged.
  const versionMove = file =>
    versionChange(
      git(['show', `HEAD:${file}`]),
      commitsAll(command)
        ? readFileSync(path.join(REPO_ROOT, file), 'utf8')
        : git(['show', `:${file}`])
    )

  if (kind === 'plugins') {
    // Each plugin releases on its own (`<id>-vX.Y.Z`, rocketflare-dev/rocketflare#181), so a
    // release commit is one that moves a plugin manifest's version, not the root package.json.
    const moved = readdirSync(path.join(REPO_ROOT, 'plugins'), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => `plugins/${d.name}/rocketflare-plugin.json`)
      .filter(file => existsSync(path.join(REPO_ROOT, file)))
      .map(file => ({ id: file.split('/')[1], change: versionMove(file) }))
      .filter(m => m.change)
    if (moved.length === 0) return
    const names = moved.map(m => `${m.id} ${m.change.to}`).join(', ')
    const where = process.env.ROCKETFLARE_WWW_DIR ?? '~/work/rocketflare-www (or $ROCKETFLARE_WWW_DIR)'
    const message = [
      `This commit releases ${names} — tags ${moved.map(m => `${m.id}-v${m.change.to}`).join(', ')}.`,
      'After each tag is pushed and its GitHub Release exists, update the website, rocketflare.dev:',
      `  1. In ${where}, create a branch.`,
      '  2. Run `npm run sync:releases` and `npm run sync:plugins` (per-plugin tags), and update',
      "     src/data/plugins.ts with each released plugin's version and its <id>-vX.Y.Z install command.",
      '  3. Run `npm run check:releases && npm run build`, then open a PR; merging deploys the site.',
      'Say so if this release deliberately needs no site change.',
    ].join('\n')
    process.stdout.write(hookJson(message, `Release ${names}: update rocketflare-www after tagging.`))
    return
  }

  const change = versionMove('package.json')
  if (!change) return

  const message = siteReminder({ ...change, kind, wwwDir: process.env.ROCKETFLARE_WWW_DIR })
  process.stdout.write(
    hookJson(message, `Release ${change.to}: remember to update rocketflare-www after tagging.`)
  )
}

try {
  main()
} catch {
  // A hook must never be the reason a commit fails.
}
process.exit(0)
