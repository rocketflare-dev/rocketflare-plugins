/**
 * One guide page's markdown, rendered: react-markdown + GFM + the guide's conventions
 * (`remarkGuide`), with raw HTML parsed (`rehype-raw`) and then SANITISED (`rehype-sanitize`, the
 * GitHub allow-list plus the guide's own heading ids and callout markup). A page may use
 * `<details>`, `<kbd>` or a `colspan` table; it can never run script, load a frame, set a style
 * or an event handler. Images render through `<img>` only, so an SVG never joins the page's DOM.
 *
 * A link between pages stays in the app; anything else opens in a new tab.
 */
import type { GuideOutlineItem } from '@rocketflare/shared/plugins/guide/index'
import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import { Link } from 'react-router-dom'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { remarkGuide } from './remarkGuide'

/**
 * GitHub's allow-list, plus: heading ids kept as the outline wrote them (no `user-content-`
 * prefix — citations link to them), and the callout's `<aside>` with its classes.
 */
export const GUIDE_SANITIZE_SCHEMA = {
  ...defaultSchema,
  clobber: [],
  clobberPrefix: '',
  tagNames: [...(defaultSchema.tagNames ?? []), 'aside'],
  attributes: {
    ...defaultSchema.attributes,
    h2: [...(defaultSchema.attributes?.h2 ?? []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 ?? []), 'id'],
    aside: ['className', 'dataCallout'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className'],
  },
}

const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, GUIDE_SANITIZE_SCHEMA],
]

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    href?.startsWith('/guide?') || href === '/guide' ? (
      <Link to={href} className="link link-accent">
        {children}
      </Link>
    ) : href?.startsWith('#') ? (
      <a href={href} className="link link-accent">
        {children}
      </a>
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  img: ({ node: _node, alt, src }) => (
    <img src={src} alt={alt ?? ''} loading="lazy" className="rounded-lg border border-base-300" />
  ),
  kbd: ({ node: _node, children }) => <kbd className="kbd kbd-sm">{children}</kbd>,
}

function GuideMarkdownImpl({
  markdown,
  pagePath,
  outline,
  calloutLabels,
}: {
  markdown: string
  pagePath: string
  outline: GuideOutlineItem[]
  calloutLabels: string[]
}) {
  const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(
    () => [remarkGfm, [remarkGuide, { pagePath, outline, calloutLabels }]],
    [pagePath, outline, calloutLabels]
  )
  return (
    <div className="guide-content prose prose-sm md:prose-base max-w-none prose-headings:scroll-mt-4">
      <ReactMarkdown remarkPlugins={plugins} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

export const GuideMarkdown = memo(GuideMarkdownImpl)
