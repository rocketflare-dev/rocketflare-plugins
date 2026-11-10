/**
 * The user guide's content model — ONE loader for the config, the pages and their outlines, so
 * everything that reads `docs/guide/` agrees on what a page is: the build script
 * (`.claude/skills/guide/scripts/guide-build.mjs`), the staleness hook (`docs-stale.mjs`), the
 * plugin's tests, and any later consumer (a CMS plugin publishing the same pages as a site).
 *
 * **Zero imports, erasable TypeScript only.** Node ≥ 24 runs this file directly with type
 * stripping, so the two skill scripts stay dependency-free: no `yaml`, no `zod`, no `node:*`
 * (hashing is passed in). That is also why the frontmatter parser below is a small YAML SUBSET
 * rather than YAML — scalars, quoted strings and lists, which is all a page's frontmatter holds —
 * and why config validation is hand-written. The zod contracts in `./index.ts` mirror it for the
 * runtime, and a test holds the two to the same answers.
 *
 * What is a page: `<part>/**\/*.md` under `docs/guide/`, never a root-level file (`VOICE.md`,
 * `README.md`) and nothing under a `_`-prefixed or dot directory. A page's directory is its part.
 */

// ---- Config ------------------------------------------------------------------------------------

export const GUIDE_AUDIENCES = ['member', 'admin'] as const
export type GuideAudience = (typeof GUIDE_AUDIENCES)[number]

export interface GuideSectionConfig {
  id: string
  label: string
}

export interface GuidePartConfig {
  id: string
  label: string
  sections: GuideSectionConfig[]
}

/** `docs/guide/guide.config.json` — the host's, seeded once and never overwritten. */
export interface GuideConfig {
  /** What the guide is called everywhere: the nav, the reader, the hook's nudge. */
  label: string
  /** The app the guide describes, as its readers know it. */
  appName: string
  /** The parts in reading order, each with its sections in reading order. */
  parts: GuidePartConfig[]
  /** Blockquote labels rendered as callouts: `> **RULE OF THUMB** — …`. */
  calloutLabels: string[]
  /** `{{fact:<key>}}` values — a page never types a number or name the config owns. */
  facts: Record<string, string>
  /** App route prefix → the page that explains that screen (`/members` → `start/inviting-people.md`). */
  screens: Record<string, string>
}

export const GUIDE_DEFAULT_LABEL = 'User guide'
export const GUIDE_CONFIG_FILE = 'guide.config.json'
/** Where the pages live, repo-relative. */
export const GUIDE_CONTENT_DIR = 'docs/guide'
/** The images directory inside {@link GUIDE_CONTENT_DIR}, and where the build copies it to. */
export const GUIDE_IMAGES_DIR = 'images'
export const GUIDE_PUBLIC_IMAGES_DIR = 'apps/web/public/guide/images'
/** The URL the copied images are served from (a static asset — no session needed). */
export const GUIDE_IMAGE_URL = '/guide/images/'
export const GUIDE_GENERATED_MODULE = 'apps/web/src/host/guide/content.generated.ts'
/** The command every "the generated module is stale" message names. */
export const GUIDE_BUILD_COMMAND = 'node .claude/skills/guide/scripts/guide-build.mjs'

const ID = /^[a-z0-9][a-z0-9-]*$/
const FACT_KEY = /^[a-z0-9][a-z0-9_.-]*$/i
const CALLOUT_LABEL = /^[A-Z][A-Z0-9 ]*[A-Z0-9]$/
const CONFIG_KEYS = new Set([
  '$schema',
  'label',
  'appName',
  'parts',
  'calloutLabels',
  'facts',
  'screens',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Validate a parsed `guide.config.json`. Returns the config with defaults applied, or the list of
 * problems — each naming the field and what to write instead.
 */
export function validateGuideConfig(
  data: unknown
): { config: GuideConfig; problems: [] } | { config: null; problems: string[] } {
  const problems: string[] = []
  if (!isRecord(data)) return { config: null, problems: ['the config must be a JSON object'] }
  for (const key of Object.keys(data)) {
    if (!CONFIG_KEYS.has(key))
      problems.push(`unknown key "${key}" (allowed: ${[...CONFIG_KEYS].join(', ')})`)
  }
  const label = data.label === undefined ? GUIDE_DEFAULT_LABEL : data.label
  if (!nonEmpty(label) || label.length > 60)
    problems.push('"label" must be a non-empty string of at most 60 characters')
  if (!nonEmpty(data.appName) || data.appName.length > 80) {
    problems.push('"appName" must be the app\'s name, a non-empty string of at most 80 characters')
  }

  const parts: GuidePartConfig[] = []
  if (!Array.isArray(data.parts) || data.parts.length === 0) {
    problems.push('"parts" must be a non-empty array of { id, label, sections: [{ id, label }] }')
  } else {
    const seen = new Set<string>()
    data.parts.forEach((raw, i) => {
      const where = `parts[${i}]`
      if (!isRecord(raw)) {
        problems.push(`${where} must be an object`)
        return
      }
      const id = raw.id
      if (typeof id !== 'string' || !ID.test(id)) {
        problems.push(`${where}.id must be lower-case kebab-case (it is the part's directory name)`)
        return
      }
      if (seen.has(id)) problems.push(`${where}.id "${id}" is declared twice`)
      seen.add(id)
      if (!nonEmpty(raw.label)) problems.push(`${where}.label must be a non-empty string`)
      const sections: GuideSectionConfig[] = []
      if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
        problems.push(`${where}.sections must be a non-empty array of { id, label }`)
      } else {
        const ids = new Set<string>()
        raw.sections.forEach((s, j) => {
          const sw = `${where}.sections[${j}]`
          if (!isRecord(s) || typeof s.id !== 'string' || !ID.test(s.id) || !nonEmpty(s.label)) {
            problems.push(`${sw} must be { id: kebab-case, label: non-empty string }`)
            return
          }
          if (ids.has(s.id)) problems.push(`${sw}.id "${s.id}" is declared twice in part "${id}"`)
          ids.add(s.id)
          sections.push({ id: s.id, label: s.label })
        })
      }
      parts.push({ id, label: typeof raw.label === 'string' ? raw.label : id, sections })
    })
  }

  const calloutLabels: string[] = []
  if (data.calloutLabels !== undefined) {
    if (!Array.isArray(data.calloutLabels))
      problems.push('"calloutLabels" must be an array of upper-case labels')
    else {
      for (const l of data.calloutLabels) {
        if (typeof l !== 'string' || !CALLOUT_LABEL.test(l)) {
          problems.push(
            `calloutLabels: "${String(l)}" must be upper-case letters, digits and spaces ("RULE OF THUMB")`
          )
        } else calloutLabels.push(l)
      }
    }
  }

  const facts: Record<string, string> = {}
  if (data.facts !== undefined) {
    if (!isRecord(data.facts)) problems.push('"facts" must be an object of { key: value }')
    else {
      for (const [key, value] of Object.entries(data.facts)) {
        if (!FACT_KEY.test(key))
          problems.push(`facts: key "${key}" must be letters, digits, ".", "_" or "-"`)
        else if (typeof value === 'string' || typeof value === 'number') facts[key] = String(value)
        else problems.push(`facts.${key} must be a string or a number`)
      }
    }
  }

  const screens: Record<string, string> = {}
  if (data.screens !== undefined) {
    if (!isRecord(data.screens))
      problems.push('"screens" must be an object of { "/route-prefix": "part/page.md" }')
    else {
      for (const [route, page] of Object.entries(data.screens)) {
        if (!/^\/[\w\-./:]*$/.test(route))
          problems.push(`screens: "${route}" must be an app route prefix starting with "/"`)
        else if (typeof page !== 'string' || !page.endsWith('.md')) {
          problems.push(
            `screens["${route}"] must name a page path such as "start/getting-started.md"`
          )
        } else screens[route] = page
      }
    }
  }

  if (problems.length > 0) return { config: null, problems }
  return {
    config: {
      label: label as string,
      appName: data.appName as string,
      parts,
      calloutLabels,
      facts,
      screens,
    },
    problems: [],
  }
}

// ---- Frontmatter (a YAML subset) ---------------------------------------------------------------

export interface GuideFrontmatter {
  title: string
  part: string
  section: string
  order: number
  audience: GuideAudience
  summary: string
  /** Coarse repo-relative globs of the code this page describes — read by `docs-stale.mjs`. */
  sources: string[]
  /** The commit at which this page was last checked against its sources. */
  verified: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FRONTMATTER_KEYS = [
  'title',
  'part',
  'section',
  'order',
  'audience',
  'summary',
  'sources',
  'verified',
]

export class GuideContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuideContentError'
  }
}

/** One YAML scalar: quoted strings unescaped, integers and booleans typed, `#` comments dropped. */
function yamlScalar(raw: string): unknown {
  const v = raw.trim()
  if (v.startsWith('"')) {
    const end = findClosingQuote(v, '"')
    if (end === -1) throw new GuideContentError(`an unterminated "…" string: ${v}`)
    return JSON.parse(v.slice(0, end + 1)) as string
  }
  if (v.startsWith("'")) {
    const end = findClosingQuote(v, "'")
    if (end === -1) throw new GuideContentError(`an unterminated '…' string: ${v}`)
    return v.slice(1, end).replace(/''/g, "'")
  }
  const plain = v.replace(/\s+#.*$/, '').trim()
  if (plain === '' || plain === '~' || plain === 'null') return null
  if (plain === 'true' || plain === 'false') return plain === 'true'
  if (/^-?\d+$/.test(plain)) return Number(plain)
  if (/^-?\d+\.\d+$/.test(plain)) return Number(plain)
  if (/^[>|]/.test(plain))
    throw new GuideContentError(
      'block scalars (> or |) are not supported: keep the value on one line'
    )
  return plain
}

function findClosingQuote(v: string, q: string): number {
  for (let i = 1; i < v.length; i++) {
    if (q === '"' && v[i] === '\\') {
      i++
      continue
    }
    if (v[i] === q) {
      if (q === "'" && v[i + 1] === "'") {
        i++
        continue
      }
      return i
    }
  }
  return -1
}

/** `[a, "b, c", 'd']` → its items. */
function yamlFlowList(raw: string): unknown[] {
  const inner = raw
    .trim()
    .replace(/^\[/, '')
    .replace(/\]\s*(#.*)?$/, '')
  if (!inner.trim()) return []
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string
    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"') {
        current += inner[++i] ?? ''
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      items.push(current)
      current = ''
    } else current += ch
  }
  items.push(current)
  return items.map(yamlScalar)
}

/**
 * The `---` block at the top of a page as an object, and the markdown after it. Supports the YAML
 * a page needs — `key: scalar`, `key: [flow, list]` and a block list of `- item` lines — and
 * throws a readable {@link GuideContentError} on anything else.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = FRONTMATTER.exec(raw)
  if (!m) throw new GuideContentError('no frontmatter (a page starts with a --- block)')
  const data: Record<string, unknown> = {}
  let listKey: string | null = null
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item && listKey) {
      ;(data[listKey] as unknown[]).push(yamlScalar(item[1] ?? ''))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (!kv) throw new GuideContentError(`frontmatter line is not "key: value": ${line.trim()}`)
    const key = kv[1] as string
    const value = (kv[2] ?? '').trim()
    if (Object.hasOwn(data, key))
      throw new GuideContentError(`frontmatter key "${key}" appears twice`)
    listKey = null
    if (value === '' || value.startsWith('#')) {
      data[key] = []
      listKey = key
    } else if (value.startsWith('[')) data[key] = yamlFlowList(value)
    else data[key] = yamlScalar(value)
  }
  return { data, body: raw.slice(m[0].length) }
}

/** Problems with a page's frontmatter against the config; empty when it is valid. */
export function frontmatterProblems(
  pagePath: string,
  data: Record<string, unknown>,
  config: GuideConfig
): string[] {
  const problems: string[] = []
  for (const key of Object.keys(data)) {
    if (!FRONTMATTER_KEYS.includes(key))
      problems.push(`unknown frontmatter key "${key}" (allowed: ${FRONTMATTER_KEYS.join(', ')})`)
  }
  for (const key of ['title', 'summary', 'part', 'section'] as const) {
    if (!nonEmpty(data[key])) problems.push(`"${key}" must be a non-empty string`)
  }
  if (typeof data.order !== 'number' || !Number.isInteger(data.order))
    problems.push('"order" must be an integer')
  if (!(GUIDE_AUDIENCES as readonly unknown[]).includes(data.audience))
    problems.push('"audience" must be member or admin')
  const sources = data.sources
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(nonEmpty)) {
    problems.push('"sources" must be a non-empty list of repo-relative globs')
  }
  if (typeof data.verified === 'number') {
    problems.push(
      `"verified" is all digits, which YAML reads as a number: quote it (verified: "${data.verified}")`
    )
  } else if (typeof data.verified !== 'string' || !/^[0-9a-f]{7,40}$/.test(data.verified)) {
    problems.push('"verified" must be a commit sha (7 to 40 hex characters)')
  }
  const part = config.parts.find(p => p.id === data.part)
  if (nonEmpty(data.part) && !part) {
    problems.push(
      `part "${data.part}" is not in guide.config.json (${config.parts.map(p => p.id).join(', ')})`
    )
  }
  if (part && nonEmpty(data.section) && !part.sections.some(s => s.id === data.section)) {
    problems.push(
      `section "${data.section}" is not one of the ${part.id} sections (${part.sections.map(s => s.id).join(', ')})`
    )
  }
  if (nonEmpty(data.part) && pagePath.split('/')[0] !== data.part) {
    problems.push(`a ${data.part} page lives under ${data.part}/`)
  }
  return problems
}

// ---- Pages -------------------------------------------------------------------------------------

/** Whether a path relative to `docs/guide/` is a page. */
export function isGuidePagePath(rel: string): boolean {
  if (!rel.endsWith('.md')) return false
  const segs = rel.split('/')
  if (segs.length < 2) return false
  if (segs.some(s => s === '' || s.startsWith('.'))) return false
  if (segs.slice(0, -1).some(s => s.startsWith('_'))) return false
  return segs[0] !== GUIDE_IMAGES_DIR
}

// ---- Headings: ONE scan, shared by the outline, the sections and the reader ---------------------

/**
 * The anchor slug of a heading — one function for every half: the build stamps it on the outline
 * and the indexed sections, the reader gives the rendered heading that id, a citation names it.
 */
export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/['’"“”]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}

/** A per-page slugger: the first `Do it` is `do-it`, the second `do-it-1`. */
export function guideSlugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return text => {
    const base = slugifyHeading(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

/** A heading's text as the reader shows it: inline code, emphasis and link syntax removed. */
export function headingPlainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .trim()
}

export interface GuideHeading {
  /** The 0-based line the heading sits on. */
  line: number
  level: number
  text: string
  id: string
}

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/**
 * Every ATX heading from H2 down outside a fenced code block, in order, with its id from ONE
 * slugger — so a repeated `## Do it` is `do-it-1` in the outline, the section that cites it and on
 * the rendered page alike. A `## …` inside a fence is code, not a heading.
 */
export function scanGuideHeadings(md: string): GuideHeading[] {
  const slug = guideSlugger()
  const out: GuideHeading[] = []
  let fence: string | null = null
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const marker = FENCE_LINE.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    const h = HEADING_LINE.exec(line)
    if (!h) continue
    const level = (h[1] as string).length
    if (level === 1) continue
    const text = headingPlainText(h[2] as string)
    out.push({ line: i, level, text, id: slug(text) })
  }
  return out
}

export interface GuideOutlineItem {
  id: string
  text: string
  level: number
}

/** The reader's outline: the page's H2 and H3 headings. */
export function guideOutline(readerMarkdown: string): GuideOutlineItem[] {
  return scanGuideHeadings(readerMarkdown)
    .filter(h => h.level <= 3)
    .map(h => ({ id: h.id, text: h.text, level: h.level }))
}

// ---- Links -------------------------------------------------------------------------------------

/** The reader's route. */
export const GUIDE_PATH = '/guide'

/** The reader URL for a page, optionally at a heading — the one shape every link into it takes. */
export function guideHref(page: string, heading?: string | null): string {
  const hash = heading ? `#${encodeURIComponent(heading)}` : ''
  return `${GUIDE_PATH}?path=${encodeURIComponent(page)}${hash}`
}

export interface GuideLinkTarget {
  path: string
  hash: string | null
}

const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

function decodeHrefPart(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** POSIX `normalize(join(dirname(from), rel))` for relative paths — no `node:path` in a browser. */
function joinRelative(fromPath: string, rel: string): string | null {
  const out = fromPath.split('/').slice(0, -1)
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

/**
 * The page a link written on `fromPath` names, or null when it is not a link between pages.
 * Pages link the way markdown files do (`../start/x.md`, `x.md#heading`, `#heading`) so they read
 * correctly in the repository too; the build holds every one to a real page and heading.
 */
export function resolveGuideLink(href: string, fromPath: string): GuideLinkTarget | null {
  const h = href.trim()
  if (!h || EXTERNAL_HREF.test(h) || h.startsWith('/')) return null
  const hashAt = h.indexOf('#')
  const target = hashAt >= 0 ? h.slice(0, hashAt) : h
  const hash = hashAt >= 0 ? decodeHrefPart(h.slice(hashAt + 1)) || null : null
  if (target === '') return hash ? { path: fromPath, hash } : null
  if (!/\.md$/i.test(target)) return null
  const resolved = joinRelative(fromPath, decodeHrefPart(target))
  if (!resolved) return null
  return { path: resolved, hash }
}

/** A link on page `pagePath` → the reader URL of the page it names, or the href unchanged. */
export function guideLinkHref(href: string, pagePath: string): string {
  const target = resolveGuideLink(href, pagePath)
  return target ? guideHref(target.path, target.hash) : href
}

/** An image reference on `fromPath` → its file name under `images/`, or null when it is not one. */
export function resolveGuideImage(src: string, fromPath: string): string | null {
  const s = src.trim()
  if (!s || EXTERNAL_HREF.test(s) || s.startsWith('/')) return null
  const resolved = joinRelative(fromPath, decodeHrefPart(s))
  if (!resolved?.startsWith(`${GUIDE_IMAGES_DIR}/`)) return null
  const file = resolved.slice(GUIDE_IMAGES_DIR.length + 1)
  return file && !file.includes('/') ? file : null
}

// ---- Facts -------------------------------------------------------------------------------------

const FACT = /\{\{\s*fact:([a-z0-9][a-z0-9_.-]*)\s*\}\}/gi

/** The fact keys a body names. */
export function guideFactKeys(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(FACT)].map(m => m[1] as string))]
}

/** Resolve `{{fact:key}}`; the keys the config does not define are returned, never guessed. */
export function resolveGuideFacts(
  markdown: string,
  facts: Readonly<Record<string, string>>
): { text: string; unknown: string[] } {
  const unknown = new Set<string>()
  const text = markdown.replace(FACT, (m, key: string) => {
    if (!Object.hasOwn(facts, key)) {
      unknown.add(key)
      return m
    }
    return facts[key] as string
  })
  return { text, unknown: [...unknown] }
}

// ---- Images ------------------------------------------------------------------------------------

export const GUIDE_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const

const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'marker',
  'use',
  'symbol',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
])
const SVG_TAG = /^<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/
const SVG_ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * Why an SVG may not be served as a guide image — empty when it may. An allow-list, so it fails
 * closed: shapes, text, markers and gradients only; every attribute quoted; no `on*=` handler; no
 * link or `url()` leaving the file (only `#fragment`s); no `javascript:` or `data:`; no DOCTYPE,
 * entity, CDATA or processing instruction past the XML declaration. The reader shows an image
 * through `<img>` only, so nothing in it runs in the page; this keeps a figure safe when somebody
 * opens its URL directly.
 */
export function guideSvgProblems(svg: string): string[] {
  const problems: string[] = []
  let rest = svg.replace(/^﻿/, '').replace(/^\s*<\?xml[^?]*\?>/, '')
  let root: string | null = null
  let sawTitle = false
  while (rest.length > 0) {
    const lt = rest.indexOf('<')
    if (lt === -1) break
    rest = rest.slice(lt)
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->')
      if (end === -1) {
        problems.push('an unterminated comment')
        break
      }
      rest = rest.slice(end + 3)
      continue
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      problems.push(`a declaration or instruction: ${rest.slice(0, 20)}`)
      break
    }
    const tag = SVG_TAG.exec(rest)
    if (!tag) {
      problems.push(`an unreadable tag: ${rest.slice(0, 40)}`)
      break
    }
    const [whole, closing, name = '', attrs = ''] = tag
    root ??= closing ? null : name
    if (!closing && name === 'title') sawTitle = true
    if (!closing && !SVG_ELEMENTS.has(name)) problems.push(`the element <${name}>`)
    for (const a of attrs.matchAll(SVG_ATTR)) {
      const attr = (a[1] ?? '').toLowerCase()
      const value = a[2] ?? a[3] ?? ''
      if (attr.startsWith('on')) problems.push(`the event handler ${a[1]}`)
      if (/javascript:|data:/i.test(value)) problems.push(`a script or data URL in ${a[1]}`)
      if ((attr === 'href' || attr.endsWith(':href')) && !value.startsWith('#')) {
        problems.push(`an outside reference in ${a[1]}: ${value}`)
      }
      for (const u of value.matchAll(/url\(\s*['"]?([^'")\s]*)/gi)) {
        if (!(u[1] ?? '').startsWith('#')) problems.push(`an outside url() in ${a[1]}`)
      }
    }
    rest = rest.slice(whole.length)
  }
  if (root !== 'svg') problems.push('the root element is not <svg>')
  else if (!sawTitle) problems.push('no <title> (a figure says what it shows)')
  return problems
}

// ---- The bundle --------------------------------------------------------------------------------

/** One file under `docs/guide/`: its POSIX path relative to it, and its text. */
export interface GuideSourceFile {
  path: string
  raw: string
}

/** One H2 section of a page — what is indexed as one platform document. */
export interface GuideSection {
  /** The H2's id, or null for the text before the first H2. */
  heading: string | null
  /** `Page` or `Page › Section` — the platform document's title. */
  title: string
  /** Led by the title, links between pages turned into reader URLs, image lines dropped. */
  text: string
}

export interface GuideBundlePage {
  /** Relative to `docs/guide/`, e.g. `start/getting-started.md` — the citation key. */
  path: string
  frontmatter: GuideFrontmatter
  /** The reader's markdown: facts resolved, the leading `# Title` dropped, images at their URL. */
  markdown: string
  outline: GuideOutlineItem[]
  sections: GuideSection[]
  /** sha256 of the file and the values of the facts it names. */
  contentHash: string
}

/** What `content.generated.ts` holds: the whole guide, validated, in reading order. */
export interface GuideBundle {
  version: 1
  /** Over the config and every page's hash: what the search index is compared against. */
  hash: string
  config: GuideConfig
  pages: GuideBundlePage[]
  /** Image file names under `docs/guide/images/`, sorted. */
  images: string[]
}

export interface GuideProblem {
  /** Relative to `docs/guide/`. */
  file: string
  message: string
}

/** sha256 hex — passed in, so this module needs no `node:crypto`. */
export type GuideHash = (text: string) => string

const IMAGE_REF = /!\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g
const LINK_REF = /(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g
const IMAGE_ONLY_LINE = /^!\[[^\]]*\]\([^)]*\)\s*$/

/** Sort by part (config order), then section order, then `order`, then path. */
export function compareGuidePages(
  config: GuideConfig
): (
  a: Pick<GuideBundlePage, 'path' | 'frontmatter'>,
  b: Pick<GuideBundlePage, 'path' | 'frontmatter'>
) => number {
  const partIndex = new Map(config.parts.map((p, i) => [p.id, i]))
  const sectionIndex = (part: string, section: string) => {
    const i = config.parts.find(p => p.id === part)?.sections.findIndex(s => s.id === section) ?? -1
    return i === -1 ? 99 : i
  }
  return (a, b) =>
    (partIndex.get(a.frontmatter.part) ?? 99) - (partIndex.get(b.frontmatter.part) ?? 99) ||
    sectionIndex(a.frontmatter.part, a.frontmatter.section) -
      sectionIndex(b.frontmatter.part, b.frontmatter.section) ||
    a.frontmatter.order - b.frontmatter.order ||
    a.path.localeCompare(b.path)
}

/** The page split at H2 into its indexed sections (ids from the reader's own scan). */
export function guideSections(path: string, title: string, readerMarkdown: string): GuideSection[] {
  const lines = readerMarkdown.split('\n')
  const h2s = scanGuideHeadings(readerMarkdown).filter(h => h.level === 2)
  const out: GuideSection[] = []
  let start = 0
  let current: GuideHeading | null = null
  const linked = (text: string) =>
    text.replace(LINK_REF, (m, label: string, href: string) => {
      const url = guideLinkHref(href, path)
      return url === href ? m : `[${label}](${url})`
    })
  for (const h of [...h2s, null]) {
    const end = h ? h.line : lines.length
    const body = lines
      .slice(start, end)
      .filter(l => !IMAGE_ONLY_LINE.test(l.trim()))
      .join('\n')
      .trim()
    if (body) {
      const sectionTitle = current ? `${title} › ${current.text}` : title
      out.push({
        heading: current?.id ?? null,
        title: sectionTitle,
        text: `${sectionTitle}\n\n${linked(body)}`,
      })
    }
    if (h) {
      current = h
      start = h.line + 1
    }
  }
  return out
}

/**
 * Validate and assemble the whole guide. `files` are every file under `docs/guide/` except
 * images (the config, `VOICE.md` and the pages); `images` the file names in `images/` with their
 * text when they are SVG. Every problem is collected — a run reports them all, not the first.
 */
export function buildGuideBundle(input: {
  files: readonly GuideSourceFile[]
  images: readonly { name: string; svg?: string }[]
  hash: GuideHash
}): { bundle: GuideBundle; problems: [] } | { bundle: null; problems: GuideProblem[] } {
  const problems: GuideProblem[] = []
  const add = (file: string, message: string) => problems.push({ file, message })

  const configFile = input.files.find(f => f.path === GUIDE_CONFIG_FILE)
  if (!configFile) {
    return {
      bundle: null,
      problems: [{ file: GUIDE_CONFIG_FILE, message: 'missing — run /guide init' }],
    }
  }
  let parsedConfig: unknown
  try {
    parsedConfig = JSON.parse(configFile.raw)
  } catch (err) {
    return {
      bundle: null,
      problems: [
        { file: GUIDE_CONFIG_FILE, message: `not valid JSON — ${(err as Error).message}` },
      ],
    }
  }
  const validated = validateGuideConfig(parsedConfig)
  if (!validated.config) {
    return {
      bundle: null,
      problems: validated.problems.map(message => ({ file: GUIDE_CONFIG_FILE, message })),
    }
  }
  const config = validated.config

  const images = new Set<string>()
  for (const img of input.images) {
    const ext = img.name.split('.').pop()?.toLowerCase() ?? ''
    const file = `${GUIDE_IMAGES_DIR}/${img.name}`
    if (!/^[\w.-]+$/.test(img.name))
      add(file, 'an image name is letters, digits, ".", "_" and "-" only')
    else if (!(GUIDE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      add(file, `not an image the guide serves (${GUIDE_IMAGE_EXTENSIONS.join(', ')})`)
    } else if (ext === 'svg') {
      for (const p of guideSvgProblems(img.svg ?? '')) add(file, `unsafe SVG: ${p}`)
    }
    images.add(img.name)
  }

  const drafts: { page: Omit<GuideBundlePage, 'outline' | 'sections'>; raw: string }[] = []
  for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isGuidePagePath(file.path)) continue
    let fm: { data: Record<string, unknown>; body: string }
    try {
      fm = parseFrontmatter(file.raw)
    } catch (err) {
      add(file.path, (err as Error).message)
      continue
    }
    const fmProblems = frontmatterProblems(file.path, fm.data, config)
    if (fmProblems.length > 0) {
      for (const p of fmProblems) add(file.path, p)
      continue
    }
    const frontmatter = fm.data as unknown as GuideFrontmatter
    const facts = resolveGuideFacts(fm.body, config.facts)
    for (const key of facts.unknown)
      add(file.path, `unknown fact {{fact:${key}}} — add it to "facts" in guide.config.json`)
    let markdown = facts.text.replace(/^\s*#\s+[^\n]*\n+/, '')
    markdown = markdown.replace(IMAGE_REF, (m, alt: string, src: string, titlePart?: string) => {
      const name = resolveGuideImage(src, file.path)
      if (!name) {
        add(
          file.path,
          `image "${src}" must be a file in docs/guide/images/, linked relatively (../images/x.png)`
        )
        return m
      }
      if (!images.has(name)) {
        add(file.path, `image "${src}" does not exist in docs/guide/images/`)
        return m
      }
      return `![${alt}](${GUIDE_IMAGE_URL}${encodeURIComponent(name)}${titlePart ?? ''})`
    })
    if (!markdown.trim()) add(file.path, 'the page has no content')
    for (const h of scanGuideHeadings(markdown)) {
      if (h.level > 3)
        add(file.path, `heading "${h.text}" is H${h.level} — the guide uses ## and ### only`)
    }
    const keyedFacts = guideFactKeys(fm.body).map(k => `${k}=${config.facts[k] ?? ''}`)
    drafts.push({
      raw: fm.body,
      page: {
        path: file.path,
        frontmatter: {
          title: frontmatter.title,
          part: frontmatter.part,
          section: frontmatter.section,
          order: frontmatter.order,
          audience: frontmatter.audience,
          summary: frontmatter.summary,
          sources: [...frontmatter.sources],
          verified: frontmatter.verified,
        },
        markdown,
        contentHash: input.hash([file.raw, ...keyedFacts].join('\0')),
      },
    })
  }
  if (drafts.length === 0 && problems.length === 0)
    add('.', 'the guide has no pages — run /guide init')

  const pages: GuideBundlePage[] = drafts.map(({ page }) => ({
    ...page,
    outline: guideOutline(page.markdown),
    sections: guideSections(page.path, page.frontmatter.title, page.markdown),
  }))
  const byPath = new Map(pages.map(p => [p.path, p]))

  // Links between pages land on a real page and heading, and a member page never sends its reader
  // to a page they cannot open.
  for (const page of pages) {
    const ids = new Set(scanGuideHeadings(page.markdown).map(h => h.id))
    for (const m of page.markdown.matchAll(LINK_REF)) {
      const href = m[2] as string
      const target = resolveGuideLink(href, page.path)
      if (!target) {
        if (!EXTERNAL_HREF.test(href) && !href.startsWith('#') && /\.md(#|$)/i.test(href)) {
          add(page.path, `link "${href}" climbs out of docs/guide/`)
        }
        continue
      }
      const dest = byPath.get(target.path)
      if (!dest) {
        add(page.path, `link "${href}" points at a page that does not exist (${target.path})`)
        continue
      }
      const destIds = dest === page ? ids : new Set(scanGuideHeadings(dest.markdown).map(h => h.id))
      if (target.hash && !destIds.has(target.hash)) {
        add(
          page.path,
          `link "${href}" points at #${target.hash}, which is not a heading of ${dest.path}`
        )
      }
      if (page.frontmatter.audience === 'member' && dest.frontmatter.audience === 'admin') {
        add(page.path, `link "${href}": a member page links to an admin page members cannot open`)
      }
    }
  }

  // An admin page is allowed: the reader resolves a screen within its own audience, so a member
  // on an admin screen falls back to the nearest member page.
  for (const [route, target] of Object.entries(config.screens)) {
    if (!byPath.has(target))
      add(GUIDE_CONFIG_FILE, `screens["${route}"] names "${target}", which is not a page`)
  }

  if (problems.length > 0) return { bundle: null, problems }
  pages.sort(compareGuidePages(config))
  const imageList = [...images].sort()
  const hash = input.hash(
    JSON.stringify({ config, pages: pages.map(p => [p.path, p.contentHash]), images: imageList })
  )
  return { bundle: { version: 1, hash, config, pages, images: imageList }, problems: [] }
}

/** The generated module's exact text — the build writes it and the gate compares it. */
export function renderGuideModule(bundle: GuideBundle): string {
  return [
    `// Generated by \`${GUIDE_BUILD_COMMAND}\` from ${GUIDE_CONTENT_DIR}/ — do not edit by hand.`,
    '// The guide plugin imports it as @/host/guide/content.generated; a config test fails the gate',
    '// when it no longer matches the pages.',
    "import type { GuideBundle } from '@rocketflare/shared/plugins/guide/index'",
    '',
    '// biome-ignore format: generated',
    `export const GUIDE_BUNDLE: GuideBundle = ${JSON.stringify(bundle, null, 2)}`,
    '',
  ].join('\n')
}
