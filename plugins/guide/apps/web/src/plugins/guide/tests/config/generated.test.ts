/**
 * The gate's guard on the host's guide: `apps/web/src/host/guide/content.generated.ts` and
 * `apps/web/public/guide/images/` must be what `guide-build.mjs` would write from `docs/guide/`
 * today. Built in-process through the same loader the script uses, so the failure names the
 * problem (or the command to run), not just "they differ".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildGuideBundle,
  GUIDE_BUILD_COMMAND,
  GUIDE_CONFIG_FILE,
  GUIDE_CONTENT_DIR,
  GUIDE_GENERATED_MODULE,
  GUIDE_IMAGES_DIR,
  GUIDE_PUBLIC_IMAGES_DIR,
  renderGuideModule,
} from '@rocketflare/shared/plugins/guide/index'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../fixture'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../../..')

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .flatMap(e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return walk(full, base)
      return e.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : []
    })
    .sort()
}

describe('the generated guide module', () => {
  const contentDir = path.join(ROOT, GUIDE_CONTENT_DIR)
  const imagesDir = path.join(contentDir, GUIDE_IMAGES_DIR)

  it(`${GUIDE_CONTENT_DIR}/ builds, and ${GUIDE_GENERATED_MODULE} is current`, () => {
    expect(existsSync(contentDir), `${GUIDE_CONTENT_DIR}/ is missing — run /guide init`).toBe(true)
    const files = walk(contentDir)
      .filter(f => !f.startsWith(`${GUIDE_IMAGES_DIR}/`))
      .filter(f => f.endsWith('.md') || f === GUIDE_CONFIG_FILE)
      .map(f => ({ path: f, raw: readFileSync(path.join(contentDir, f), 'utf8') }))
    const images = walk(imagesDir)
      .filter(f => !f.includes('/'))
      .map(name => ({
        name,
        svg: name.toLowerCase().endsWith('.svg')
          ? readFileSync(path.join(imagesDir, name), 'utf8')
          : undefined,
      }))
    const built = buildGuideBundle({ files, images, hash: sha256 })
    expect(
      built.problems.map(p => `${GUIDE_CONTENT_DIR}/${p.file}: ${p.message}`),
      'the guide has problems'
    ).toEqual([])
    if (!built.bundle) return
    const moduleFile = path.join(ROOT, GUIDE_GENERATED_MODULE)
    const current = existsSync(moduleFile) ? readFileSync(moduleFile, 'utf8') : ''
    expect(
      current === renderGuideModule(built.bundle),
      `${GUIDE_GENERATED_MODULE} no longer matches ${GUIDE_CONTENT_DIR}/ — run \`${GUIDE_BUILD_COMMAND}\` and commit the result`
    ).toBe(true)
  })

  it(`${GUIDE_PUBLIC_IMAGES_DIR}/ mirrors ${GUIDE_CONTENT_DIR}/${GUIDE_IMAGES_DIR}/`, () => {
    const publicDir = path.join(ROOT, GUIDE_PUBLIC_IMAGES_DIR)
    const want = walk(imagesDir)
    const have = walk(publicDir)
    const same =
      want.length === have.length &&
      want.every(
        (f, i) =>
          f === have[i] &&
          readFileSync(path.join(imagesDir, f)).equals(readFileSync(path.join(publicDir, f)))
      )
    expect(same, `the guide's images are stale — run \`${GUIDE_BUILD_COMMAND}\``).toBe(true)
  })
})
