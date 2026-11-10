/**
 * `/api/global-search` — search everything, the providers' metadata, and the re-ranker settings.
 *
 *   GET  /?q&kinds&limit      any member — every provider the reader may use, fused (and maybe
 *                             re-ranked); `degraded` names providers that did not answer
 *   GET  /providers           any member — those providers' ids, labels and kinds, for the UI
 *   GET  /settings            manage GlobalSearchConfig — the re-ranker settings, `hasCredential`
 *   PUT  /settings            manage GlobalSearchConfig — partial update; seals a new key
 *   POST /settings/test       manage GlobalSearchConfig — one live re-rank, always 200 with a verdict
 *
 * A plain kit route in every respect: `createRouter()`, `validate()` with the shared contract,
 * `ctx.guard`, and a tenant id that only ever comes from `ctx`. A bad provider registration is a
 * thrown `InvalidSearchProviderError` (a 500 and a log line naming the plugins) — loud, by design.
 */
import {
  GLOBAL_SEARCH_CONFIG_SUBJECT,
  GLOBAL_SEARCH_SETTINGS_ENTITY,
  type GlobalSearchQuery,
  globalSearchQuerySchema,
  type SearchProvidersResponse,
  type TestRerankRequest,
  type TestRerankResponse,
  testRerankRequestSchema,
  type UpdateGlobalSearchSettings,
  updateGlobalSearchSettingsSchema,
} from '@rocketflare/shared/plugins/global-search/index'
import type { Actions, AppRouter, RequestCtx, Subjects } from '@/plugins/api'
import { createRouter, openSecret, recordActivity, requestCtx, validate } from '@/plugins/api'
import { installedProviders } from '../services/registry'
import { createRerankClient, RerankError } from '../services/rerank'
import { globalSearch, usableProviders } from '../services/search'
import {
  loadSettingsRow,
  nextSettings,
  resolveReranker,
  saveSettings,
  toSettings,
} from '../services/settings'
import type { SearchProviderCtx } from '../types'

/** Two documents any re-ranker can order; the answer is counted, never shown. */
const TEST_QUERY = 'reset a password'
const TEST_DOCUMENTS = [
  'Quarterly revenue grew in the northern region.',
  'To reset your password, open your profile and choose Reset password.',
]

function providerCtx(ctx: RequestCtx): SearchProviderCtx {
  return {
    db: ctx.db,
    config: ctx.config,
    env: ctx.env,
    scope: ctx.scope,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    isAdmin: ctx.isAdmin,
    can: (action, subject) => ctx.can(action as Actions, subject as Subjects),
  }
}

function buildRouter(): AppRouter {
  const r = createRouter()

  r.get('/', validate('query', globalSearchQuerySchema), async c => {
    const ctx: RequestCtx = requestCtx(c)
    const query = ctx.valid<
      Required<Pick<GlobalSearchQuery, 'q' | 'limit'>> & { kinds?: string[] }
    >('query')
    const search = providerCtx(ctx)
    const providers = usableProviders(installedProviders(), search.can)
    const result = await globalSearch(
      providers,
      search,
      { q: query.q, kinds: query.kinds, limit: query.limit },
      {
        logger: ctx.logger,
        reranker: () => resolveReranker(ctx.db, ctx.config, ctx.tenantId),
      }
    )
    return c.json(result)
  })

  r.get('/providers', async c => {
    const ctx: RequestCtx = requestCtx(c)
    const providers = usableProviders(installedProviders(), providerCtx(ctx).can)
    const body: SearchProvidersResponse = {
      providers: providers.map(p => ({
        id: p.id,
        label: p.label,
        kinds: [...p.kinds].sort((a, b) => a.order - b.order),
        ...(p.snippetLabels
          ? {
              snippetLabels: {
                fields: [...p.snippetLabels.fields],
                ...(p.snippetLabels.noise ? { noise: [...p.snippetLabels.noise] } : {}),
                ...(p.snippetLabels.bare ? { bare: [...p.snippetLabels.bare] } : {}),
              },
            }
          : {}),
      })),
    }
    return c.json(body)
  })

  r.get('/settings', async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', GLOBAL_SEARCH_CONFIG_SUBJECT as Subjects)
    return c.json(toSettings(await loadSettingsRow(ctx.db, ctx.tenantId)))
  })

  r.put('/settings', validate('json', updateGlobalSearchSettingsSchema), async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', GLOBAL_SEARCH_CONFIG_SUBJECT as Subjects)
    const body = ctx.valid<UpdateGlobalSearchSettings>('json')
    const existing = await loadSettingsRow(ctx.db, ctx.tenantId)
    const next = nextSettings(existing, body)
    if (next.rerankEnabled && !next.complete) {
      ctx.badRequest(
        'Add the re-ranker URL, model and API key before turning re-ranking on',
        'global_search_rerank_incomplete'
      )
    }
    const row = await saveSettings(ctx.db, ctx.config, ctx.tenantId, ctx.userId, next)
    ctx.defer(() =>
      recordActivity(ctx.db, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        type: 'global-search.settings.updated',
        subjectType: GLOBAL_SEARCH_CONFIG_SUBJECT,
        subjectId: row.id,
        // What changed, never the key itself.
        metadata: { rerankEnabled: row.rerankEnabled, model: row.rerankModel, key: next.key.kind },
      })
    )
    ctx.nudge(GLOBAL_SEARCH_SETTINGS_ENTITY)
    return c.json(toSettings(row))
  })

  r.post('/settings/test', validate('json', testRerankRequestSchema), async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', GLOBAL_SEARCH_CONFIG_SUBJECT as Subjects)
    const body = ctx.valid<TestRerankRequest>('json')
    const existing = await loadSettingsRow(ctx.db, ctx.tenantId)
    const baseUrl = body.rerankBaseUrl ?? existing?.rerankBaseUrl ?? null
    const model = body.rerankModel ?? existing?.rerankModel ?? null
    // A stored key is only good for the URL it was saved under.
    const apiKey =
      body.rerankApiKey ??
      (existing?.rerankApiKeyEnc && baseUrl === existing.rerankBaseUrl
        ? await openSecret(ctx.config, existing.rerankApiKeyEnc)
        : null)
    let verdict: TestRerankResponse
    if (!baseUrl || !model || !apiKey) {
      verdict = { ok: false, error: 'Add a URL, a model and an API key first', code: 'incomplete' }
    } else {
      const started = Date.now()
      try {
        const client = createRerankClient({ baseUrl, model, apiKey })
        const { results } = await client.rerank(TEST_QUERY, TEST_DOCUMENTS, {
          signal: AbortSignal.timeout(5000),
        })
        verdict = { ok: true, latencyMs: Date.now() - started, scored: results.length }
      } catch (err) {
        verdict =
          err instanceof RerankError
            ? { ok: false, error: err.message, code: err.code }
            : { ok: false, error: 'The re-ranker did not answer in time', code: 'timeout' }
      }
    }
    return c.json(verdict)
  })

  return r
}

export const globalSearchRouter = buildRouter()
