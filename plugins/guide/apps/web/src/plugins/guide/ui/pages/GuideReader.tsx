/**
 * The guide reader at `/guide`. Three panes: the contents rail (with the guide's own search box),
 * the page, and "Ask the Guide". The page lives in `?path=` with `#heading` anchors, so every page
 * and section is linkable (citations and search hits land here); with no path it opens the first
 * page. Every signed-in member reads it; admins also see the admin pages, and a banner when the
 * search index is not built.
 */
import { ChatBubbleLeftRightIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import {
  type GuideIndexState,
  type GuideTocEntry,
  type GuideTocResponse,
  guideHref,
} from '@rocketflare/shared/plugins/guide/index'
import { useQuery } from '@tanstack/react-query'
import { type RefObject, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, EmptyState, LoadingIndicator } from '@/plugins/api/ui'
import GuideChat from '../components/GuideChat'
import { guideConversation } from '../lib/conversation'
import { guidePageQuery, guideTocQuery } from '../lib/queries'
import { GuideMarkdown } from './GuideMarkdown'
import { GuideSearch } from './GuideSearch'
import { GuideToc } from './GuideToc'
import { ReaderLayout } from './ReaderLayout'

/** The `#heading` a reader URL points at, if any. */
export function headingFromHash(hash: string): string | null {
  if (!hash || hash === '#') return null
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return hash.slice(1)
  }
}

const INDEX_BANNERS: Partial<Record<GuideIndexState, string>> = {
  no_embeddings:
    "The guide's search index isn't built: configure embeddings (EMBEDDINGS_API_KEY or the [ai] binding). Until then search and Ask the Guide find nothing.",
  building:
    "The guide's search index is being built. Search and Ask the Guide may miss pages until it finishes.",
}

export default function GuideReader() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { hash } = useLocation()
  const navigate = useNavigate()
  const selectedPath = searchParams.get('path') ?? ''
  const heading = headingFromHash(hash)
  const contentRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLTextAreaElement>(null)

  // The header's `?` focuses THIS pane while the reader is open, instead of opening the slide-over.
  useEffect(() => {
    guideConversation.registerAskPane(() => askRef.current?.focus())
    return () => guideConversation.registerAskPane(null)
  }, [])

  const tocQuery = useQuery(guideTocQuery())
  const toc = tocQuery.data
  const entries = useMemo(() => toc?.entries ?? [], [toc])
  const first = entries[0]

  useEffect(() => {
    if (!selectedPath && first) setSearchParams({ path: first.path }, { replace: true })
  }, [selectedPath, first, setSearchParams])

  const openPage = (path: string) => navigate(guideHref(path))

  if (tocQuery.isLoading) return <LoadingIndicator size="xl" centered />
  if (tocQuery.isError || !toc) {
    return (
      <div className="p-8">
        <EmptyState message="Could not load the guide." />
      </div>
    )
  }

  const banner = toc.index ? INDEX_BANNERS[toc.index] : undefined
  return (
    <ReaderLayout
      contentRef={contentRef}
      toc={
        <GuideToc
          label={toc.label}
          appName={toc.appName}
          parts={toc.parts}
          entries={entries}
          selectedPath={selectedPath}
          onSelect={openPage}
          search={<GuideSearch onOpen={href => navigate(href)} />}
        />
      }
      aside={
        <>
          <div className="flex flex-none items-center gap-1.5 border-b border-base-300 px-4 py-2.5 text-sm font-semibold">
            <ChatBubbleLeftRightIcon className="h-4 w-4 text-primary" />
            Ask the Guide
          </div>
          <div className="min-h-0 flex-1">
            <GuideChat inputRef={askRef} />
          </div>
        </>
      }
    >
      {banner && (
        <div role="status" className="alert alert-warning m-4 mb-0 rounded-lg text-sm">
          <ExclamationTriangleIcon className="h-5 w-5" />
          <span>{banner}</span>
        </div>
      )}
      {entries.length === 0 ? (
        <div className="p-8">
          <EmptyState message="The guide has no pages yet." />
        </div>
      ) : (
        <GuidePageView
          toc={toc}
          path={selectedPath}
          heading={heading}
          entries={entries}
          scrollRef={contentRef}
          onSelect={openPage}
          onSearch={href => navigate(href)}
        />
      )}
    </ReaderLayout>
  )
}

function GuidePageView({
  toc,
  path,
  heading,
  entries,
  scrollRef,
  onSelect,
  onSearch,
}: {
  toc: GuideTocResponse
  path: string
  heading: string | null
  entries: GuideTocEntry[]
  scrollRef: RefObject<HTMLDivElement | null>
  onSelect: (path: string) => void
  onSearch: (href: string) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const query = useQuery(guidePageQuery(path))
  const idx = entries.findIndex(e => e.path === path)
  const prev = idx > 0 ? entries[idx - 1] : null
  const next = idx >= 0 && idx < entries.length - 1 ? entries[idx + 1] : null
  const partLabel = (part: string) => toc.parts.find(p => p.id === part)?.label ?? part

  const data = query.data
  // Once the page is in the DOM, scroll to the cited heading (if any), else to the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: data/heading are the triggers; refs are stable
  useEffect(() => {
    if (!data) return
    const target = heading ? bodyRef.current?.querySelector(`#${CSS.escape(heading)}`) : null
    if (target) {
      target.scrollIntoView?.({ block: 'start' })
      return
    }
    const el = scrollRef.current
    if (el) el.scrollTop = 0
  }, [data, heading])

  if (!path || query.isLoading) return <LoadingIndicator size="xl" centered />
  if (query.isError || !data) {
    const missing = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="space-y-4 p-8">
        <EmptyState
          message={missing ? 'This page of the guide does not exist.' : 'Could not load this page.'}
        />
        {missing && entries[0] && (
          <div className="text-center">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onSelect(entries[0]?.path ?? '')}
            >
              Go to the start of the guide
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <article className="mx-auto w-full max-w-[1040px] px-4 py-6 sm:px-6 md:px-10 md:py-8">
      <div className="mb-4 space-y-2 md:hidden">
        <label className="block">
          <span className="sr-only">Guide page</span>
          <select
            className="select select-bordered select-sm w-full"
            value={path}
            onChange={e => onSelect(e.target.value)}
          >
            {entries.map(e => (
              <option key={e.path} value={e.path}>
                {partLabel(e.part)} › {e.title}
              </option>
            ))}
          </select>
        </label>
        <GuideSearch onOpen={onSearch} />
      </div>
      <p className="mb-1 text-xs font-semibold text-base-content/60">{partLabel(data.meta.part)}</p>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight md:text-3xl">{data.title}</h1>
      <div ref={bodyRef}>
        <GuideMarkdown
          markdown={data.markdown}
          pagePath={data.path}
          outline={data.outline}
          calloutLabels={data.calloutLabels}
        />
      </div>
      {(prev || next) && (
        <nav
          aria-label="Previous and next"
          className="mt-10 flex items-stretch gap-3 border-t border-base-300 pt-6"
        >
          {[prev, next].map((target, i) =>
            target ? (
              <button
                key={target.path}
                type="button"
                onClick={() => onSelect(target.path)}
                className={`flex flex-1 flex-col gap-1 rounded-lg border border-base-300 p-4 transition-colors hover:border-primary hover:bg-base-200 ${
                  i === 1 ? 'items-end text-right' : 'items-start text-left'
                }`}
              >
                <span className="text-xs text-base-content/60">
                  {i === 1 ? 'Next →' : '← Previous'}
                </span>
                <span className="text-sm font-semibold leading-snug">{target.title}</span>
              </button>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: an empty slot keeps the other aligned
              <div key={i} className="flex-1" />
            )
          )}
        </nav>
      )}
    </article>
  )
}
