/**
 * The guide's markdown conventions as one remark plugin, run by the reader before react-markdown
 * renders:
 *
 * - **Heading ids come from the server's outline**, in order, onto the page's top-level H2/H3s —
 *   the same ids the indexed sections and every citation name, so a citation always lands.
 * - **Callouts**: a blockquote opening with one of the config's `calloutLabels` in bold and a dash
 *   (`> **RULE OF THUMB** — …`) becomes an `<aside>` with its label, shown in sentence case.
 * - **Links between pages** (`../start/x.md#h`) become reader URLs.
 *
 * Pure (mdast in, mdast out) and typed loosely on purpose: the mdast types are not a dependency.
 */
import { type GuideOutlineItem, guideLinkHref } from '@rocketflare/shared/plugins/guide/index'

interface MdNode {
  type: string
  depth?: number
  value?: string
  url?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

/** Tailwind classes, kept here so the `@source` scan of plugin UI files sees them. */
export const CALLOUT_CLASS =
  'guide-callout my-6 rounded-lg border-l-4 border-accent bg-base-200 px-4 py-3'
export const CALLOUT_LABEL_CLASS =
  'guide-callout-label mb-1 text-xs font-semibold text-base-content/70'

/** `RULE OF THUMB` → `Rule of thumb`. */
export function calloutLabelText(label: string): string {
  const lower = label.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function textOf(node: MdNode): string {
  if (node.value) return node.value
  return (node.children ?? []).map(textOf).join('')
}

function walk(node: MdNode, visit: (n: MdNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function toCallout(quote: MdNode, labels: ReadonlySet<string>): void {
  const first = quote.children?.[0]
  const strong = first?.type === 'paragraph' ? first.children?.[0] : undefined
  if (!first || strong?.type !== 'strong') return
  const label = textOf(strong).trim()
  if (!labels.has(label)) return
  // Drop the label and the dash that follows it; the rest of the paragraph is the body.
  const rest = (first.children ?? []).slice(1)
  const lead = rest[0]
  if (lead?.type === 'text' && lead.value) lead.value = lead.value.replace(/^\s*[—–-]\s*/, '')
  first.children = rest
  quote.data = {
    hName: 'aside',
    hProperties: {
      className: CALLOUT_CLASS.split(' '),
      dataCallout: label.toLowerCase().replace(/\s+/g, '-'),
    },
  }
  quote.children = [
    {
      type: 'paragraph',
      data: { hName: 'div', hProperties: { className: CALLOUT_LABEL_CLASS.split(' ') } },
      children: [{ type: 'text', value: calloutLabelText(label) }],
    },
    ...(quote.children ?? []),
  ]
}

export function remarkGuide(options: {
  pagePath: string
  outline: readonly GuideOutlineItem[]
  calloutLabels: readonly string[]
}) {
  const labels = new Set(options.calloutLabels)
  return (tree: MdNode) => {
    const ids = options.outline.map(o => o.id)
    let next = 0
    for (const node of tree.children ?? []) {
      if (node.type === 'heading' && (node.depth === 2 || node.depth === 3)) {
        const id = ids[next++]
        if (id) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } }
      }
    }
    walk(tree, n => {
      if (n.type === 'blockquote') toCallout(n, labels)
      else if (n.type === 'link' && n.url) n.url = guideLinkHref(n.url, options.pagePath)
    })
  }
}
