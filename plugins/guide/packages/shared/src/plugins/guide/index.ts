/**
 * `guide` — the shared half (D31): an in-app user guide about the app itself. Markdown pages the
 * developer's coding agent writes under `docs/guide/` (kept in step with the code by a Claude Code
 * Stop hook and `/guide sync`), compiled by `guide-build.mjs` into `@/host/guide/content.generated`,
 * indexed as PLATFORM documents (readable by every organisation, always embedded), read at
 * `/guide`, searched semantically and asked through "Ask the Guide".
 *
 * The pure loader is `./content.ts` (zero imports, so the skill scripts run it with Node alone);
 * this module adds the zod contracts the routes, the UI and the tests share.
 *
 * Everything keyed carries the id: `/api/guide`, the job `guide.sync`, the prompt `guide-chat`,
 * platform sources `guide:member` / `guide:admin` / `guide:meta`, the CUSTOM event `guide.answer`,
 * query-key roots `guide:…`.
 */
import { z } from 'zod'
import type { SharedPlugin } from '../types'
import {
  GUIDE_AUDIENCES,
  GUIDE_DEFAULT_LABEL,
  type GuideAudience,
  type GuideConfig,
} from './content'

/** The whole loader — one implementation for the scripts, the server and the tests. */
export * from './content'
/** What of a model's answer a reader sees — the server's parse and the UI's stream agree. */
export * from './answer'

export const GUIDE_ID = 'guide'
export const GUIDE_API_ROOT = '/api/guide'
export const GUIDE_SYNC_JOB = 'guide.sync'
export const GUIDE_PROMPT_KEY = 'guide-chat'
/** The `ai_usage` label of an answer. */
export const GUIDE_CHAT_FEATURE = 'guide:chat'
/** The CUSTOM event an answer ends with: its text with the citations resolved. */
export const GUIDE_ANSWER_EVENT = 'guide.answer'

/** Platform sources: one per audience, plus the marker the index is checked against. */
export const GUIDE_SOURCES = { member: 'guide:member', admin: 'guide:admin' } as const
export const GUIDE_META_SOURCE = 'guide:meta'
export const GUIDE_META_EXTERNAL_ID = 'bundle'

/** The sources a reader of `audience` may search: admins read both, everyone else member pages. */
export function guideSourcesFor(isAdmin: boolean): string[] {
  return isAdmin ? [GUIDE_SOURCES.member, GUIDE_SOURCES.admin] : [GUIDE_SOURCES.member]
}

/** The audiences a reader may see — THE audience rule, applied server-side only. */
export function visibleAudiences(isAdmin: boolean): GuideAudience[] {
  return isAdmin ? ['member', 'admin'] : ['member']
}

/** A platform document's `externalId`: `<path>#<heading>`, or `<path>` for a page's intro. */
export function guideExternalId(path: string, heading: string | null): string {
  return heading ? `${path}#${heading}` : path
}

/** `<path>#<heading>` → its halves. */
export function parseGuideExternalId(externalId: string): { path: string; heading: string | null } {
  const at = externalId.indexOf('#')
  return at === -1
    ? { path: externalId, heading: null }
    : { path: externalId.slice(0, at), heading: externalId.slice(at + 1) || null }
}

// ---- Config (mirrors `validateGuideConfig`; a test holds the two to the same answers) ----------

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)

export const guideConfigSchema = z
  .object({
    $schema: z.string().optional(),
    label: z.string().trim().min(1).max(60).default(GUIDE_DEFAULT_LABEL),
    appName: z.string().trim().min(1).max(80),
    parts: z
      .array(
        z.object({
          id: idSchema,
          label: z.string().trim().min(1),
          sections: z
            .array(z.object({ id: idSchema, label: z.string().trim().min(1) }).strict())
            .min(1),
        })
      )
      .min(1)
      .superRefine((parts, ctx) => {
        const ids = parts.map(p => p.id)
        if (new Set(ids).size !== ids.length)
          ctx.addIssue({ code: 'custom', message: 'duplicate part id' })
        for (const p of parts) {
          const s = p.sections.map(x => x.id)
          if (new Set(s).size !== s.length)
            ctx.addIssue({ code: 'custom', message: `duplicate section id in ${p.id}` })
        }
      }),
    calloutLabels: z.array(z.string().regex(/^[A-Z][A-Z0-9 ]*[A-Z0-9]$/)).default([]),
    facts: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/i), z.union([z.string(), z.number()]))
      .default({})
      .transform(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)]))),
    screens: z.record(z.string().regex(/^\/[\w\-./:]*$/), z.string().regex(/\.md$/)).default({}),
  })
  .strict()
  .transform(({ $schema: _schema, ...rest }): GuideConfig => rest)

// ---- Reader ------------------------------------------------------------------------------------

export const guideAudienceSchema = z.enum(GUIDE_AUDIENCES)

/** One TOC entry — derived from frontmatter; never `sources` or `verified` (repo internals). */
export const guideTocEntrySchema = z.object({
  path: z.string(),
  title: z.string(),
  part: z.string(),
  section: z.string(),
  order: z.number().int(),
  summary: z.string(),
  audience: guideAudienceSchema,
})
export type GuideTocEntry = z.infer<typeof guideTocEntrySchema>

export const guidePartSchema = z.object({
  id: z.string(),
  label: z.string(),
  sections: z.array(z.object({ id: z.string(), label: z.string() })),
})

/**
 * The search index's state, for an admin's banner. `ready`: indexed with today's platform model.
 * `building`: a sync is queued or running. `no_embeddings`: there is no platform embedder, so the
 * guide cannot be indexed at all — search and Ask find nothing until one is configured.
 */
export const guideIndexStateSchema = z.enum(['ready', 'building', 'no_embeddings'])
export type GuideIndexState = z.infer<typeof guideIndexStateSchema>

export const guideTocResponseSchema = z.object({
  label: z.string(),
  appName: z.string(),
  parts: z.array(guidePartSchema),
  entries: z.array(guideTocEntrySchema),
  /** Admins only — `null` for everyone else. */
  index: guideIndexStateSchema.nullable(),
})
export type GuideTocResponse = z.infer<typeof guideTocResponseSchema>

export const guideOutlineItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  level: z.number().int(),
})

export const guidePageQuerySchema = z.object({ path: z.string().min(1).max(300) })

export const guidePageResponseSchema = z.object({
  path: z.string(),
  title: z.string(),
  meta: guideTocEntrySchema,
  /** Facts resolved, the H1 dropped, image URLs final; links between pages still relative. */
  markdown: z.string(),
  outline: z.array(guideOutlineItemSchema),
  calloutLabels: z.array(z.string()),
})
export type GuidePageResponse = z.infer<typeof guidePageResponseSchema>

// ---- Search ------------------------------------------------------------------------------------

export const GUIDE_SEARCH_MAX_QUERY = 500
export const GUIDE_SEARCH_LIMIT = 10

export const guideSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(GUIDE_SEARCH_MAX_QUERY),
})

export const guideSearchHitSchema = z.object({
  path: z.string(),
  heading: z.string().nullable(),
  /** `Page › Section`. */
  title: z.string(),
  pageTitle: z.string(),
  snippet: z.string(),
  href: z.string(),
  /** Found by meaning (a dense hit), not only by a shared word. */
  dense: z.boolean(),
})
export type GuideSearchHit = z.infer<typeof guideSearchHitSchema>

export const guideSearchResponseSchema = z.object({
  hits: z.array(guideSearchHitSchema),
  /** `unavailable`: no platform embedder, so this was keyword search only. */
  semantic: z.enum(['used', 'unavailable']),
})
export type GuideSearchResponse = z.infer<typeof guideSearchResponseSchema>

// ---- Ask the Guide -----------------------------------------------------------------------------

export const GUIDE_MAX_QUESTION = 4000
export const GUIDE_MAX_HISTORY = 20
export const GUIDE_MAX_TURN = 8000
/** Model turns per answer: a few searches, then the answer. */
export const GUIDE_MAX_TURNS = 6
export const GUIDE_DEFAULT_TOP_K = 8
export const GUIDE_MAX_TOP_K = 20

export const guideChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(GUIDE_MAX_TURN),
})
export type GuideChatTurn = z.infer<typeof guideChatTurnSchema>

/**
 * Where the reader is: the app ROUTE only. The server maps it to a page through the config's
 * `screens` and never passes the route itself to the model, so an id or a name in a URL never
 * reaches a chat over a corpus every organisation shares.
 */
export const guideScreenSchema = z.object({
  route: z
    .string()
    .max(300)
    .regex(/^\/[^\s]*$/, 'must be an app route'),
})

export const askGuideSchema = z.object({
  question: z.string().trim().min(1).max(GUIDE_MAX_QUESTION),
  history: z.array(guideChatTurnSchema).max(GUIDE_MAX_HISTORY).optional(),
  screen: guideScreenSchema.optional(),
})
export type AskGuideRequest = z.infer<typeof askGuideSchema>

export const guideCitationSchema = z.object({
  page: z.string().nullable(),
  heading: z.string().nullable(),
  note: z.string().nullable(),
  title: z.string(),
  /** False when the page is not one this reader can open (or does not exist). */
  valid: z.boolean(),
})
export type GuideCitation = z.infer<typeof guideCitationSchema>

export const guideAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(guideCitationSchema),
  /** `hybrid`: every search used meaning and keywords; `lexical`: one fell back to keywords. */
  retrieval: z.enum(['hybrid', 'lexical', 'none']),
})
export type GuideAnswer = z.infer<typeof guideAnswerSchema>

// ---- Jobs --------------------------------------------------------------------------------------

export const guideSyncPayloadSchema = z.object({
  /** Why it runs — logged, nothing branches on it. */
  reason: z.enum(['cron', 'lazy', 'manual']),
})

// ---- The plugin --------------------------------------------------------------------------------

export const guideShared = {
  id: GUIDE_ID,
  label: 'User guide',
  version: '3.9.0',
  promptKeys: [GUIDE_PROMPT_KEY],
  jobs: [z.object({ type: z.literal(GUIDE_SYNC_JOB), payload: guideSyncPayloadSchema })],
} as const satisfies SharedPlugin
