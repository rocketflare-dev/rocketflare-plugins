/**
 * The palette's client-side half: the "Go to" destinations (`useNavigationEntries()`) and the
 * registered COMMANDS (`extensions['global-search.commands']`), ranked in the browser as the
 * reader types — no request, so they appear on the first keystroke.
 *
 * Pure apart from `readCommands`, which reads the installed set; unit-tested in
 * `tests/config/goto.test.ts`.
 */
import {
  SEARCH_COMMANDS_EXTENSION,
  SEARCH_PROVIDER_ID_RE,
  type SearchCommand,
  type SearchCommandGuard,
  searchCommandSchema,
} from '@rocketflare/shared/plugins/global-search/index'

/** Something the palette can open without asking the server. */
export interface Destination {
  id: string
  label: string
  to: string
  /** The heading it sits under in the kit (`Organisation`, `Settings`…), also matched. */
  group: string
  keywords?: readonly string[]
  kind: 'page' | 'command'
  /** A command's own guard (`useNavGuard` vocabulary); destinations arrive already filtered. */
  guard?: SearchCommandGuard
}

/**
 * How well `query` matches `text` (higher is better, 0 = no match): the whole text, then a
 * prefix, then the start of a word, then the query's letters in order (a subsequence: "apk" →
 * "API keys"). Case-insensitive; spaces in the query are ignored for the subsequence.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q || !t) return 0
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  const words = t.split(/[\s/›·:_-]+/)
  if (words.some(w => w.startsWith(q))) return 60
  if (t.includes(q)) return 40
  let at = 0
  for (const ch of q.replace(/\s+/g, '')) {
    at = t.indexOf(ch, at)
    if (at === -1) return 0
    at++
  }
  return 20
}

/**
 * A destination's score: its label counts in full, its group and keywords a step lower, so
 * "settings" lists the Settings page before the tabs under it.
 */
export function destinationScore(query: string, d: Destination): number {
  const label = fuzzyScore(query, d.label)
  const group = fuzzyScore(query, d.group)
  const keywords = Math.max(0, ...(d.keywords ?? []).map(k => fuzzyScore(query, k)))
  return Math.max(label, group * 0.9, keywords * 0.85)
}

/** The best `limit` destinations for `query`, ties kept in their declared order. */
export function rankDestinations(
  query: string,
  destinations: readonly Destination[],
  limit: number
): Destination[] {
  return destinations
    .map((d, i) => ({ d, i, score: destinationScore(query, d) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map(x => x.d)
}

export class InvalidSearchCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSearchCommandError'
  }
}

/**
 * Validate the commands registered under `global-search.commands`: each parses, its id's plugin
 * half is one of the plugins that contributed (`sources`), ids are unique. Pure — the palette
 * logs and drops what fails (it must still open), and `tests/config/installed-commands.test.ts`
 * fails the gate on it.
 */
export function parseCommands(
  entries: readonly unknown[],
  sources: readonly string[]
): { commands: SearchCommand[]; errors: string[] } {
  const commands: SearchCommand[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  const where = `'${SEARCH_COMMANDS_EXTENSION}' (contributed by ${sources.join(', ') || 'nobody'})`
  entries.forEach((entry, i) => {
    const parsed = searchCommandSchema.safeParse(entry)
    const id = (entry as { id?: unknown } | null)?.id
    const name = typeof id === 'string' ? ` ('${id}')` : ''
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      errors.push(
        `global-search: refused a command under ${where}: entry ${i}${name} — ${issue?.path.join('.') || '(root)'}: ${issue?.message}`
      )
      return
    }
    const owner = SEARCH_PROVIDER_ID_RE.exec(parsed.data.id)?.[1] ?? ''
    if (!sources.includes(owner)) {
      errors.push(
        `global-search: refused a command under ${where}: '${parsed.data.id}' is not in a contributing plugin's namespace`
      )
      return
    }
    if (seen.has(parsed.data.id)) {
      errors.push(
        `global-search: refused a command under ${where}: duplicate id '${parsed.data.id}'`
      )
      return
    }
    seen.add(parsed.data.id)
    commands.push(parsed.data)
  })
  return { commands, errors }
}

export const commandDestination = (c: SearchCommand): Destination => ({
  id: c.id,
  label: c.label,
  to: c.to,
  group: c.group ?? 'Commands',
  ...(c.keywords ? { keywords: c.keywords } : {}),
  ...(c.guard ? { guard: c.guard } : {}),
  kind: 'command',
})
