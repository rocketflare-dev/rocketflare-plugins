/**
 * Search text as a person reads it: a passage flattened from markdown, its repeated heading and its
 * identifying fields dropped. Shared by the palette, the results page and the server, which hands
 * the re-ranker each hit's title plus this text, so the model judges what the reader sees. Pure,
 * no zod.
 *
 * Which `Label: value` fields a snippet carries is the PROVIDER's business
 * (`SearchProvider.snippetLabels`): a provider whose text is `Question: … Rule: …` names those
 * labels, and the ones that only identify (`Id`, `Source`) as `noise`. Labels are literal strings.
 */
import type { SearchSnippetLabels } from './index'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const labelRe = (labels: readonly string[]) =>
  labels.length > 0
    ? new RegExp(
        `(?:^|\\s)(${[...labels]
          .sort((a, b) => b.length - a.length)
          .map(escapeRe)
          .join('|')}): `,
        'g'
      )
    : null

/**
 * Markdown read as plain text (snippets are flattened passages, so structure is gone anyway):
 * HTML comments and tags and blockquote marks dropped, `[label](url)` → label, images dropped,
 * table separator rows dropped and cell pipes → ` · `, code fences and backticks dropped, a list
 * marker or heading marks mid-text dropped, emphasis marks dropped.
 */
export function flattenMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi, '')
    .replace(/(^|\s)>\s+/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)?/g, '$1')
    .replace(/\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?/g, ' ')
    .replace(/```[a-z]*/g, ' ')
    .replace(/`/g, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(^|\s)[-*]\s+(?=\S)/g, '$1')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?: ·)+(?= )/g, ' ·')
    .replace(/(?:\s*·\s*)+$/, '')
    .replace(/^(?:\s*·\s*)+/, '')
    .trim()
}

/**
 * A snippet as a person reads it: no leading heading or breadcrumb repeating the title, the
 * provider's `noise` fields dropped, other fields joined with ` · `, markdown marks dropped.
 * Without `labels` it is `flattenMarkdown` plus the repeated-title cleanup.
 */
export function cleanSnippet(
  snippet: string | null | undefined,
  title = '',
  labels?: SearchSnippetLabels
): string | null {
  if (!snippet) return null
  // A section's passage opens with its breadcrumb and then its heading again
  // (`API › API › POST /orders POST /orders Creates…`): keep what follows. A document's opening
  // passage repeats its title (`Orders Orders We are…`): keep what follows.
  let text = flattenMarkdown(snippet)
    .replace(/^(?:[^›]{1,80} › )+([^›]{1,120}?) \1(?: |$)/, '')
    .replace(/^(.{6,120}?) \1(?: |$)/, '')
  const re = labelRe(labels?.fields ?? [])
  // A leading heading: drop the title it repeats (or everything up to the first field).
  const heading = /^#{1,6}\s+/.exec(snippet.trim())
  if (heading) {
    let first: RegExpExecArray | null = null
    if (re) {
      re.lastIndex = 0
      first = re.exec(text)
    }
    if (title && text.startsWith(title)) text = text.slice(title.length)
    else if (first && first.index < 200) text = text.slice(first.index)
    text = text.trim()
  }
  if (!re) return text.replace(/\s+/g, ' ').trim() || null
  const noise = new Set(labels?.noise ?? [])
  const bare = new Set(labels?.bare ?? [])
  const fields: { label: string | null; value: string }[] = []
  re.lastIndex = 0
  let at = 0
  let label: string | null = null
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const value = text.slice(at, m.index).trim()
    if (value || label) fields.push({ label, value })
    label = m[1] ?? null
    at = m.index + m[0].length
  }
  fields.push({ label, value: text.slice(at).trim() })
  const out = fields
    .filter(f => f.value && !(f.label && noise.has(f.label)))
    .map(f => (f.label && !bare.has(f.label) ? `${f.label}: ${f.value}` : f.value))
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()
  return out || null
}
