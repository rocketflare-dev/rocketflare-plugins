/**
 * What the two guide scripts share: where the repository is, and the guide's pure loader.
 *
 * Dependency-free (Node >= 24). The loader is the plugin's own shared module,
 * `packages/shared/src/plugins/guide/content.ts`, which has no imports and only erasable
 * TypeScript, so Node runs it directly with type stripping — the scripts, the server and the tests
 * read the guide through ONE implementation.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** `.claude/skills/guide/scripts/` → the repository root, unless `--root <dir>` says otherwise. */
export function repoRoot(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--root')
  if (at !== -1 && argv[at + 1]) return path.resolve(argv[at + 1])
  return INSTALL_ROOT
}

export const LOADER = 'packages/shared/src/plugins/guide/content.ts'

/** The host checkout these scripts were installed into (where the loader lives). */
export const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The pure loader — always the INSTALLED host's, whichever repository `--root` points at. */
export async function loadContentModule() {
  const file = path.join(INSTALL_ROOT, LOADER)
  if (!existsSync(file)) {
    throw new Error(`${LOADER} is missing — is the guide plugin installed? (pnpm plugin list)`)
  }
  return import(pathToFileURL(file).href)
}

/** Strip `--root <dir>` so each script's own flag check sees only its flags. */
export function flagsOf(argv = process.argv.slice(2)) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      i++
      continue
    }
    out.push(argv[i])
  }
  return out
}
