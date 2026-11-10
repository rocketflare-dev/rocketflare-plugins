/**
 * `docs-stale.mjs` — which guide pages describe code that changed after their `verified` commit —
 * and the Stop hook's one line. The rules run against a temporary git repository (a real `git`,
 * no network); the hook's state goes to a temp file through `GUIDE_STATE_FILE`, never to this
 * checkout's `.claude/skills/guide/.state.json`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../../..')
const SCRIPT = path.join(ROOT, '.claude/skills/guide/scripts/docs-stale.mjs')
const LIB = path.join(ROOT, '.claude/skills/guide/scripts/docs-stale-lib.mjs')

let repo: string
let stateFile: string
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  writeFileSync(path.join(repo, rel), text)
}
const commit = (msg: string) => {
  git('add', '-A')
  git('commit', '-q', '-m', msg)
  return git('rev-parse', '--short', 'HEAD')
}
const page = (sources: string, verified: string) =>
  `---\ntitle: Members\npart: start\nsection: basics\norder: 1\naudience: member\nsummary: x\nsources: [${sources}]\nverified: "${verified}"\n---\n\n# Members\n\nBody.\n`

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: undefined, GUIDE_STATE_FILE: stateFile, ...env },
  })
  return { code: res.status, out: res.stdout, err: res.stderr }
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'guide-stale-'))
  stateFile = path.join(repo, '..', `${path.basename(repo)}-state.json`)
  git('init', '-q')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  write(
    'docs/guide/guide.config.json',
    JSON.stringify({ label: 'Acme handbook', appName: 'Acme', parts: [] })
  )
  write('src/members.ts', 'export const a = 1\n')
  write('src/other.ts', 'export const b = 1\n')
  const first = commit('code')
  write('docs/guide/start/members.md', page('src/members.ts', first))
  commit('page')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(stateFile, { force: true })
})

beforeEach(() => {
  rmSync(stateFile, { force: true })
  git('checkout', '-q', '--', '.')
  git('clean', '-qfd')
})

describe('docs-stale (history)', () => {
  it('is clean right after the page was verified', () => {
    const { code, out } = run(['--json'])
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ mode: 'history', checked: 1, stale: [], errors: [] })
  })

  it('a later commit to a source makes the page stale; a commit touching the page counts as a check', () => {
    write('src/members.ts', 'export const a = 2\n')
    commit('change members')
    write('src/other.ts', 'export const b = 2\n')
    commit('unrelated')
    const stale = JSON.parse(run(['--json']).out)
    expect(stale.stale.map((s: { doc: string }) => s.doc)).toEqual(['docs/guide/start/members.md'])
    expect(stale.stale[0].files).toEqual([{ path: 'src/members.ts', added: 1, deleted: 1 }])

    // The sync commit: code and page together — the page is checked by that commit.
    write('src/members.ts', 'export const a = 3\n')
    const raw = readFileSync(path.join(repo, 'docs/guide/start/members.md'), 'utf8')
    write('docs/guide/start/members.md', raw.replace('Body.', 'Body, checked.'))
    commit('sync')
    // The earlier change is still after `verified` and was not in a page commit.
    expect(JSON.parse(run(['--json']).out).stale).toHaveLength(1)
    const head = git('rev-parse', '--short', 'HEAD')
    write('docs/guide/start/members.md', page('src/members.ts', head))
    commit('bump verified')
    expect(JSON.parse(run(['--json']).out).stale).toEqual([])
  })

  it('reports structural errors (exit 1): a glob matching nothing, an unknown sha, a missing field', () => {
    write('docs/guide/start/gone.md', page('src/nowhere/**', 'abcdef0'))
    write('docs/guide/start/bare.md', '---\ntitle: Bare\n---\n\nBody.\n')
    const { code, out } = run(['--json'])
    expect(code).toBe(1)
    const messages = JSON.parse(out).errors.map(
      (e: { doc: string; message: string }) => `${e.doc}: ${e.message}`
    )
    expect(messages).toEqual(
      expect.arrayContaining([
        'docs/guide/start/gone.md: source glob matches no files: src/nowhere/**',
        'docs/guide/start/gone.md: verified sha is not a known commit: abcdef0',
        'docs/guide/start/bare.md: bad or missing sources, verified',
      ])
    )
  })

  it('--quiet prints nothing when clean', () => {
    expect(run(['--quiet'])).toMatchObject({ code: 0, out: '' })
  })
})

describe('docs-stale --changed (the working tree)', () => {
  it('flags a page whose source is modified or new, and not one being edited alongside it', () => {
    expect(JSON.parse(run(['--changed', '--json']).out).stale).toEqual([])
    write('src/members.ts', 'export const a = 9\n')
    const human = run(['--changed'])
    expect(human.out).toContain('Acme handbook: these pages describe code you changed')
    expect(human.out).toContain('docs/guide/start/members.md ← src/members.ts (+1 -1)')
    const raw = readFileSync(path.join(repo, 'docs/guide/start/members.md'), 'utf8')
    write('docs/guide/start/members.md', raw.replace('Body.', 'Body, synced.'))
    expect(JSON.parse(run(['--changed', '--json']).out).stale).toEqual([])
  })
})

describe('docs-stale --hook (the Stop hook)', () => {
  it('silent when nothing is stale; ONE line of systemMessage when it is; exit 0 always', () => {
    expect(run(['--changed', '--quiet', '--hook'])).toMatchObject({ code: 0, out: '' })
    write('src/members.ts', 'export const a = 10\n')
    const { code, out, err } = run(['--changed', '--quiet', '--hook'])
    expect(code).toBe(0)
    expect(err).toBe('')
    const lines = out.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] as string)
    expect(Object.keys(parsed)).toEqual(['systemMessage'])
    expect(parsed.systemMessage).toBe(
      'Acme handbook may be stale — you changed functionality it describes. Run /guide sync to sweep it before you commit.'
    )
    // Names no file, no page, never "docs".
    expect(parsed.systemMessage).not.toMatch(/members|\.md|\.ts|docs/i)
    expect(parsed.systemMessage).not.toContain('\u001b[')
  })

  it('says it once: silent while the stale set is unchanged, again when it changes or after a clean run', () => {
    write('src/members.ts', 'export const a = 11\n')
    expect(run(['--changed', '--quiet', '--hook']).out).not.toBe('')
    expect(run(['--changed', '--quiet', '--hook']).out).toBe('')
    // A second page goes stale: a new set, a new nudge.
    write('src/other.ts', 'export const b = 3\n')
    write('docs/guide/start/other.md', page('src/other.ts', git('rev-parse', '--short', 'HEAD')))
    git('add', 'docs/guide/start/other.md')
    git('commit', '-q', '-m', 'other page')
    expect(run(['--changed', '--quiet', '--hook']).out).not.toBe('')
    // Clean again forgets the nudge…
    git('checkout', '-q', '--', 'src')
    expect(run(['--changed', '--quiet', '--hook']).out).toBe('')
    // …so the same change nudges again.
    write('src/members.ts', 'export const a = 11\n')
    expect(run(['--changed', '--quiet', '--hook']).out).not.toBe('')
  })

  it('colours only with --color, and NO_COLOR or --no-color turn it off', () => {
    write('src/members.ts', 'export const a = 12\n')
    const coloured = JSON.parse(
      run(['--changed', '--quiet', '--hook', '--color']).out
    ).systemMessage
    expect(coloured).toContain('\u001b[1m\u001b[36mAcme handbook\u001b[0m')
    expect(coloured).toContain('\u001b[33m/guide sync\u001b[0m')
    for (const [args, env] of [
      [['--color', '--no-color'], {}],
      [['--color'], { NO_COLOR: '1' }],
    ] as const) {
      rmSync(stateFile, { force: true })
      const msg = JSON.parse(
        run(['--changed', '--quiet', '--hook', ...args], env).out
      ).systemMessage
      expect(msg).not.toContain('\u001b[')
    }
  })

  it('never fails the turn: an unknown flag or a broken repository is silent, exit 0', () => {
    expect(run(['--changed', '--hook', '--bogus'])).toMatchObject({ code: 0, out: '' })
    const empty = mkdtempSync(path.join(tmpdir(), 'guide-nogit-'))
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--root', empty, '--changed', '--quiet', '--hook'],
      {
        encoding: 'utf8',
        env: { ...process.env, GUIDE_STATE_FILE: stateFile },
      }
    )
    rmSync(empty, { recursive: true, force: true })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })
})

describe('the formatter, unit', () => {
  it('points the starter pages at /guide init, and a label it is given', async () => {
    const { hookMessage, SEED_VERIFIED } = await import(LIB)
    const report = {
      mode: 'changed',
      checked: 2,
      stale: [],
      errors: [
        {
          doc: 'docs/guide/start/a.md',
          message: `verified sha is not a known commit: ${SEED_VERIFIED}`,
        },
      ],
    }
    expect(hookMessage(report, { label: 'Help centre' })).toBe(
      'Help centre still holds the starter pages nobody has checked against this app. Run /guide init to write it from the code.'
    )
    expect(hookMessage({ ...report, errors: [] })).toBeNull()
  })
})
