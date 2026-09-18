/**
 * `/api/web-knowledge` — the organisation's web-search settings.
 *
 *   GET  /settings          read WebSearchConfig    — the settings, `hasCredential` never the key
 *   PUT  /settings          manage WebSearchConfig  — partial update; seals a new key
 *   POST /settings/test     manage WebSearchConfig  — one live query, always 200 with a verdict
 *
 * A plain kit route in every respect: `createRouter()`, `validate()` with the shared contract,
 * `ctx.guard`, and a tenant id that only ever comes from `ctx`.
 */
import {
  type TestWebSearchRequest,
  type TestWebSearchResponse,
  testWebSearchRequestSchema,
  type UpdateWebSearchSettings,
  updateWebSearchSettingsSchema,
  WEB_SEARCH_CONFIG_SUBJECT,
  WEB_SEARCH_SETTINGS_ENTITY,
  webSearchProviderSchema,
} from '@rocketflare/shared/plugins/web-knowledge/index'
import type { RequestCtx } from '@/plugins/api'
import { createRouter, recordActivity, requestCtx, validate } from '@/plugins/api'
import { SEARCH_ADAPTERS, WebSearchError } from '../services/providers'
import { loadRow, nextSettings, openKey, saveSettings, toSettings } from './settings'

export const webKnowledgeRouter = createRouter()

/** Any query that returns results on every provider; the answer is counted, never shown. */
const TEST_QUERY = 'Cloudflare Workers'

/** Unbound `fetch` throws "Illegal invocation" on Workers once it is called as a method. */
const outboundFetch: typeof fetch = (input, init) => fetch(input, init)

webKnowledgeRouter.get('/settings', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', WEB_SEARCH_CONFIG_SUBJECT)
  return c.json(toSettings(await loadRow(ctx.db, ctx.tenantId)))
})

webKnowledgeRouter.put('/settings', validate('json', updateWebSearchSettingsSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', WEB_SEARCH_CONFIG_SUBJECT)
  const body = ctx.valid<UpdateWebSearchSettings>('json')
  const existing = await loadRow(ctx.db, ctx.tenantId)
  const next = nextSettings(existing, body)
  if (next.enabled && !next.hasKey) {
    ctx.badRequest(
      'Add an API key for this provider before turning web search on',
      'web_search_key_required'
    )
  }
  const row = await saveSettings(ctx.db, ctx.config, ctx.tenantId, ctx.userId, next)
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'web-knowledge.settings.updated',
      subjectType: 'WebSearchConfig',
      subjectId: row.id,
      // What changed, never the key itself.
      metadata: { provider: row.provider, enabled: row.enabled, key: next.key.kind },
    })
  )
  ctx.nudge(WEB_SEARCH_SETTINGS_ENTITY)
  return c.json(toSettings(row))
})

webKnowledgeRouter.post('/settings/test', validate('json', testWebSearchRequestSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', WEB_SEARCH_CONFIG_SUBJECT)
  const body = ctx.valid<TestWebSearchRequest>('json')
  const existing = await loadRow(ctx.db, ctx.tenantId)
  const stored = webSearchProviderSchema.safeParse(existing?.provider)
  const provider = body.provider ?? (stored.success ? stored.data : 'tavily')
  // A stored key is only good for the provider it was saved under.
  const apiKey =
    body.apiKey ??
    (existing?.apiKeyEnc && stored.success && stored.data === provider
      ? await openKey(ctx.config, existing.apiKeyEnc)
      : null)
  let verdict: TestWebSearchResponse
  if (!apiKey) {
    verdict = { ok: false, provider, error: 'No API key saved for this provider', code: 'no_key' }
  } else {
    const started = Date.now()
    try {
      const results = await SEARCH_ADAPTERS[provider].search(
        { apiKey, fetch: outboundFetch },
        TEST_QUERY,
        1
      )
      verdict = {
        ok: true,
        provider,
        latencyMs: Date.now() - started,
        resultCount: results.length,
      }
    } catch (err) {
      verdict =
        err instanceof WebSearchError
          ? { ok: false, provider, error: err.message, code: err.code }
          : { ok: false, provider, error: 'The test failed unexpectedly', code: 'unknown' }
    }
  }
  return c.json(verdict)
})
