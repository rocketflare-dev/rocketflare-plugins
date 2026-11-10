/**
 * Keeping the search index in step with the bundle — the guide as PLATFORM documents.
 *
 * One platform document per page and H2 section: `source` `guide:member` / `guide:admin` by the
 * page's audience, `externalId` `<path>#<heading>` (`<path>` for the text before the first H2),
 * title `Page › Section`. Then everything else in each source is pruned, and a MARKER document
 * (`guide:meta` / `bundle`, its text the bundle hash) is written last — it says "this bundle is
 * fully indexed, by this model". Ingest is a no-op for an unchanged section, so a re-sync costs one
 * read per section and no embeddings call.
 *
 * Two triggers, both enqueue `guide.sync` (a route never runs it):
 *
 * - the plugin's daily cron task;
 * - a LAZY check on `/api/guide` requests: the marker's text against the bundle hash, its
 *   embedding model against today's platform model. Memoised per isolate, so a mismatch enqueues
 *   at most once per {@link LAZY_RETRY_MS}, and a match is never read again until the bundle or the
 *   model changes.
 *
 * Embeddings are mandatory: without a platform embedder `ingestPlatformDocument` throws
 * `PlatformEmbeddingsError`, which the job lets fail loudly (the queue retries, then dead-letters);
 * the reader shows admins a banner instead.
 */
import { DEFAULT_MODELS } from '@rocketflare/shared/ai/config'
import type { JobOf } from '@rocketflare/shared/jobs'
import {
  GUIDE_META_EXTERNAL_ID,
  GUIDE_META_SOURCE,
  GUIDE_SOURCES,
  GUIDE_SYNC_JOB,
  type GuideBundle,
  type GuideIndexState,
  guideExternalId,
} from '@rocketflare/shared/plugins/guide/index'
import { and, eq, isNull } from 'drizzle-orm'
import {
  type CronCtx,
  cronCtx,
  ingestPlatformDocument,
  type JobCtx,
  type JobHandler,
  jobCtx,
  type PluginBindings,
  type PluginConfig,
  type PluginContext,
  prunePlatformDocuments,
  type ScheduledTask,
} from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { guideBundle } from '../content'

/** Daily at 04:20 UTC — declared in `plugin.json` `crons`; the lazy check covers a fresh deploy. */
export const GUIDE_CRON = '20 4 * * *'
/** How long a mismatch waits before the lazy check enqueues again in the same isolate. */
export const LAZY_RETRY_MS = 5 * 60_000

/**
 * The platform embedder's model, or null when there is none — the rule `resolvePlatformEmbeddings`
 * applies (`EMBEDDINGS_API_KEY` → OpenAI's default, else the `[ai]` binding → Workers AI's).
 *
 * ⚠️ A COPY of the kit's rule: `@/plugins/api` exports no way to ask which platform model is in
 * use, and the lazy check must know when it changed. Keep it in step with
 * `services/ai/resolve.ts` until the kit exports one.
 */
export function platformEmbeddingModel(
  config: Pick<PluginConfig, 'EMBEDDINGS_API_KEY'>,
  env: Pick<PluginBindings, 'AI'>
): string | null {
  if (config.EMBEDDINGS_API_KEY) return DEFAULT_MODELS.openai
  if (env.AI) return DEFAULT_MODELS.workers_ai
  return null
}

/** The marker's text for a bundle. */
export function markerText(bundle: GuideBundle): string {
  return `User guide index for bundle ${bundle.hash}`
}

export interface GuideSyncResult {
  created: number
  updated: number
  unchanged: number
  pruned: number
}

/** Ingest every section of `bundle`, prune the rest, then write the marker. Idempotent. */
export async function syncGuide(
  ctx: JobCtx | CronCtx,
  bundle: GuideBundle = guideBundle()
): Promise<GuideSyncResult> {
  const result: GuideSyncResult = { created: 0, updated: 0, unchanged: 0, pruned: 0 }
  const keep: Record<string, string[]> = { [GUIDE_SOURCES.member]: [], [GUIDE_SOURCES.admin]: [] }
  for (const page of bundle.pages) {
    const source = GUIDE_SOURCES[page.frontmatter.audience]
    for (const section of page.sections) {
      const externalId = guideExternalId(page.path, section.heading)
      const written = await ingestPlatformDocument(ctx, {
        source,
        externalId,
        title: section.title,
        text: section.text,
      })
      result[written.status]++
      keep[source]?.push(externalId)
    }
  }
  for (const [source, keepExternalIds] of Object.entries(keep)) {
    result.pruned += await prunePlatformDocuments(ctx, { source, keepExternalIds })
  }
  // Last: the marker says the whole bundle is in, so a sync that failed half-way is retried.
  await ingestPlatformDocument(ctx, {
    source: GUIDE_META_SOURCE,
    externalId: GUIDE_META_EXTERNAL_ID,
    title: 'User guide index',
    text: markerText(bundle),
  })
  ctx.logger.info({ ...result, bundle: bundle.hash }, 'guide.sync')
  return result
}

export const handleGuideSync: JobHandler<typeof GUIDE_SYNC_JOB> = async (
  job: JobOf<typeof GUIDE_SYNC_JOB>,
  raw
) => {
  const ctx = jobCtx(raw)
  ctx.logger.info({ reason: job.payload.reason }, 'guide.sync: starting')
  await syncGuide(ctx)
}

export const guideSyncTask: ScheduledTask = {
  name: 'guide.sync',
  run: async raw => {
    const ctx = cronCtx(raw)
    await ctx.enqueue({ type: GUIDE_SYNC_JOB, payload: { reason: 'cron' } })
  },
}

// ---- the index's state, and the lazy check ---------------------------------------------------

/** The marker row, read on the request's own (scoped) client — platform rows are readable by all. */
async function readMarker(
  db: PluginContext['db']
): Promise<{ content: string; embeddingModel: string | null } | null> {
  // ⚠️ `allTables()`: `@/plugins/api` has no read of ONE platform document by (source, externalId).
  const { documents } = allTables()
  const [row] = await db
    .select({ content: documents.content, embeddingModel: documents.embeddingModel })
    .from(documents)
    .where(
      and(
        isNull(documents.tenantId),
        eq(documents.source, GUIDE_META_SOURCE),
        eq(documents.externalId, GUIDE_META_EXTERNAL_ID)
      )
    )
    .limit(1)
  return row ? { content: row.content ?? '', embeddingModel: row.embeddingModel ?? null } : null
}

/** Per isolate: the last answer for (bundle hash, model), and when a sync was last enqueued. */
const memo = new Map<string, { state: GuideIndexState; enqueuedAt: number }>()

/** Forget the memo — for tests, which change the bundle and the model under one isolate. */
export function resetGuideIndexMemo(): void {
  memo.clear()
}

/**
 * The index's state for this bundle and model, enqueuing `guide.sync` when it is out of date. Never
 * throws: a failed check is logged and answered as `building`, because the reader must still load.
 */
export async function ensureGuideIndex(
  ctx: Pick<PluginContext, 'db' | 'config' | 'env' | 'logger'> & {
    enqueue: (input: {
      type: typeof GUIDE_SYNC_JOB
      payload: { reason: 'lazy' }
    }) => Promise<unknown>
  },
  bundle: GuideBundle = guideBundle(),
  now: number = Date.now()
): Promise<GuideIndexState> {
  const model = platformEmbeddingModel(ctx.config, ctx.env)
  if (!model) return 'no_embeddings'
  const key = `${bundle.hash}:${model}`
  const known = memo.get(key)
  if (known?.state === 'ready') return 'ready'
  try {
    // While building, the marker is re-read (one indexed row) so `ready` shows the moment the job
    // lands; only the ENQUEUE waits out the retry window.
    const marker = await readMarker(ctx.db)
    if (marker?.content === markerText(bundle) && marker.embeddingModel === model) {
      memo.set(key, { state: 'ready', enqueuedAt: 0 })
      return 'ready'
    }
    if (known && now - known.enqueuedAt < LAZY_RETRY_MS) return 'building'
    await ctx.enqueue({ type: GUIDE_SYNC_JOB, payload: { reason: 'lazy' } })
    memo.set(key, { state: 'building', enqueuedAt: now })
    return 'building'
  } catch (err) {
    ctx.logger.warn({ err }, 'guide: index check failed')
    return 'building'
  }
}
