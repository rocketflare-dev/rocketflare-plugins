/**
 * The re-ranker: ONE client for every Cohere-style `POST {base}/rerank` endpoint, and
 * `applyRerank`, which reorders the head of a fused list within a time budget and never throws.
 *
 * The dialect follows the base URL's host (`rerankDialect`):
 *
 * | dialect   | cap field | results     | usage                                   |
 * |-----------|-----------|-------------|-----------------------------------------|
 * | cohere    | `top_n`   | `results[]` | `meta.billed_units` (search units — no tokens) |
 * | voyage    | `top_k`   | `data[]`    | `usage.total_tokens`                    |
 * | fireworks | `top_n`   | `data[]`    | `usage.prompt_tokens` / `total_tokens`; unknown fields refused, document text returned unless `return_documents: false` |
 *
 * Each result is `{ index, relevance_score }` in all three (a self-hosted server answering `score`
 * is read too). The parse is tolerant of either array name. Errors are `RerankError`s classified
 * from the status, never carrying the vendor's body (it may echo the key).
 */
import {
  RERANK_CANDIDATES,
  RERANK_TIMEOUT_MS,
  type SearchRerankSkipReason,
} from '@rocketflare/shared/plugins/global-search/index'
import { traceStep } from '@/plugins/api'

export type RerankDialect = 'cohere' | 'voyage' | 'fireworks'

/** The dialect from the base URL's HOST — never a look-alike path. */
export function rerankDialect(baseUrl: string | null | undefined): RerankDialect {
  let host = ''
  try {
    host = baseUrl ? new URL(baseUrl).hostname.toLowerCase() : ''
  } catch {
    host = ''
  }
  if (host === 'voyageai.com' || host.endsWith('.voyageai.com')) return 'voyage'
  if (host === 'fireworks.ai' || host.endsWith('.fireworks.ai')) return 'fireworks'
  return 'cohere'
}

export type RerankErrorCode = 'auth' | 'rate_limited' | 'invalid_request' | 'unavailable'

/** A re-ranker failure, classified. The message never carries the vendor's response body. */
export class RerankError extends Error {
  constructor(
    readonly code: RerankErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'RerankError'
  }
}

function classify(status: number): RerankErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'invalid_request'
  return 'unavailable'
}

export interface RerankScore {
  index: number
  score: number
}

export interface RerankResult {
  results: RerankScore[]
  /** Tokens billed, when the vendor reports any (Cohere bills search units instead). */
  inputTokens: number
}

export interface RerankClient {
  model: string
  rerank(
    query: string,
    documents: string[],
    options?: { topN?: number; signal?: AbortSignal }
  ): Promise<RerankResult>
}

export interface RerankClientOptions {
  baseUrl: string
  model: string
  apiKey: string
  fetch?: typeof fetch
}

interface RerankWireResult {
  index?: unknown
  relevance_score?: unknown
  score?: unknown
}

export interface RerankWireResponse {
  results?: RerankWireResult[]
  data?: RerankWireResult[]
  usage?: { total_tokens?: unknown; prompt_tokens?: unknown }
  meta?: { tokens?: { input_tokens?: unknown } }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The request body for a dialect — only fields that dialect accepts (Fireworks refuses others). */
export function rerankBody(
  baseUrl: string | null | undefined,
  model: string,
  query: string,
  documents: string[],
  topN?: number
): Record<string, unknown> {
  const dialect = rerankDialect(baseUrl)
  const body: Record<string, unknown> = { model, query, documents }
  if (topN !== undefined) body[dialect === 'voyage' ? 'top_k' : 'top_n'] = topN
  if (dialect === 'fireworks') body.return_documents = false
  return body
}

/** Results best first, from any of the three shapes; an entry with no usable index is dropped. */
export function parseRerankResponse(json: RerankWireResponse, count: number): RerankResult {
  const raw = json.results ?? json.data ?? []
  const results: RerankScore[] = []
  const seen = new Set<number>()
  for (const r of Array.isArray(raw) ? raw : []) {
    const index = num(r?.index)
    const score = num(r?.relevance_score) ?? num(r?.score)
    if (index === null || score === null || index < 0 || index >= count || seen.has(index)) continue
    seen.add(index)
    results.push({ index, score })
  }
  results.sort((a, b) => b.score - a.score || a.index - b.index)
  const tokens =
    num(json.usage?.total_tokens) ??
    num(json.usage?.prompt_tokens) ??
    num(json.meta?.tokens?.input_tokens) ??
    0
  return { results, inputTokens: tokens }
}

/** Unbound `fetch` throws "Illegal invocation" on Workers once it is called as a method. */
const outboundFetch: typeof fetch = (input, init) => fetch(input, init)

export function createRerankClient(opts: RerankClientOptions): RerankClient {
  if (!opts.apiKey) throw new RerankError('auth', 'An API key is required')
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) throw new RerankError('invalid_request', 'A base URL is required')
  if (!opts.model) throw new RerankError('invalid_request', 'A rerank model is required')
  const { apiKey, model } = opts
  const fetchImpl = opts.fetch ?? outboundFetch
  return {
    model,
    async rerank(query, documents, options = {}) {
      if (documents.length === 0) return { results: [], inputTokens: 0 }
      let res: Response
      try {
        res = await fetchImpl(`${base}/rerank`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(rerankBody(base, model, query, documents, options.topN)),
          signal: options.signal,
        })
      } catch (err) {
        if (options.signal?.aborted) throw err
        throw new RerankError('unavailable', 'The re-ranker could not be reached')
      }
      if (!res.ok) {
        // Drain without reading it into the message: a vendor body may echo the key.
        await res.body?.cancel().catch(() => {})
        throw new RerankError(
          classify(res.status),
          `The re-ranker answered ${res.status}`,
          res.status
        )
      }
      let json: RerankWireResponse
      try {
        json = (await res.json()) as RerankWireResponse
      } catch {
        throw new RerankError('unavailable', 'The re-ranker answered something that is not JSON')
      }
      return parseRerankResponse(json ?? {}, documents.length)
    },
  }
}

// ---- Applying a re-ranker -------------------------------------------------------------------------

export interface RerankOutcome {
  applied: boolean
  model?: string
  reason?: SearchRerankSkipReason
  latencyMs?: number
}

/** One item's rerank facts: its score and its 1-based position before and after. */
export interface RerankPlacement {
  score: number
  before: number
  after: number
}

export interface ApplyRerankOptions {
  timeoutMs?: number
  candidates?: number
}

/**
 * Re-rank `items` (already in fused order) by `query`: the first `candidates` are sent with
 * `textOf(item)`, reordered by the re-ranker's score, and followed by any it dropped and then the
 * rest — all in their fused order. Never throws: no re-ranker, a timeout or a provider failure
 * returns the items UNCHANGED with `applied: false` and the reason. Traced as `rerank <model>`.
 */
export async function applyRerank<T>(
  client: RerankClient | null,
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
  options: ApplyRerankOptions = {}
): Promise<{ items: T[]; placements: Map<T, RerankPlacement>; outcome: RerankOutcome }> {
  const unchanged = (outcome: RerankOutcome) => ({
    items: [...items],
    placements: new Map<T, RerankPlacement>(),
    outcome,
  })
  if (!client) return unchanged({ applied: false, reason: 'not_configured' })
  const model = client.model
  if (items.length < 2) return unchanged({ applied: false, reason: 'too_few', model })
  const head = items.slice(0, options.candidates ?? RERANK_CANDIDATES)
  const tail = items.slice(head.length)
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? RERANK_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('rerank timeout'))
    }, timeoutMs)
  })
  const startedAt = Date.now()
  try {
    const { results } = await Promise.race([
      traceStep(
        {
          name: `rerank ${model}`,
          kind: 'retrieval',
          input: { query, count: head.length },
          attributes: { 'gen_ai.request.model': model },
        },
        () => client.rerank(query, head.map(textOf), { signal: controller.signal }),
        r => ({ output: { scored: r.results.length, top: r.results.slice(0, 5) } })
      ),
      deadline,
    ])
    const scored = results.filter(r => r.index < head.length)
    const picked = new Set(scored.map(r => r.index))
    const order = [
      ...scored.map(r => ({ index: r.index, score: r.score as number | null })),
      ...head.map((_, index) => ({ index, score: null })).filter(e => !picked.has(e.index)),
    ]
    const placements = new Map<T, RerankPlacement>()
    const reordered = order.map((entry, position) => {
      const item = head[entry.index] as T
      if (entry.score !== null) {
        placements.set(item, { score: entry.score, before: entry.index + 1, after: position + 1 })
      }
      return item
    })
    return {
      items: [...reordered, ...tail],
      placements,
      outcome: { applied: true, model, latencyMs: Date.now() - startedAt },
    }
  } catch {
    return unchanged({
      applied: false,
      reason: controller.signal.aborted ? 'timeout' : 'error',
      model,
      latencyMs: Date.now() - startedAt,
    })
  } finally {
    clearTimeout(timer)
  }
}
