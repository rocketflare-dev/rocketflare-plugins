/**
 * One "Ask the Guide" answer over AG-UI (`POST /api/guide/ask`), read as server-sent events.
 * Loaded LAZILY (from the conversation's first question), so nothing here rides in the shell.
 *
 * Frames used: `TEXT_MESSAGE_CONTENT` (the answer as it is written, citations block included),
 * `TOOL_CALL_START` / `TOOL_CALL_ARGS` (each search), CUSTOM `guide.answer` (the answer with its
 * citations resolved), `RUN_ERROR`. Anything else is ignored, so a newer server's frame never
 * breaks an older tab. A cancelled answer simply ends.
 */
import {
  type AskGuideRequest,
  GUIDE_ANSWER_EVENT,
  GUIDE_API_ROOT,
  type GuideAnswer,
  guideAnswerSchema,
} from '@rocketflare/shared/plugins/guide/index'
import { ApiError, notifyUnauthorized } from '@/plugins/api/ui'

export interface GuideAskHandlers {
  onDelta: (text: string) => void
  /** A search started: the tool's name and its query, when readable. */
  onProgress: (tool: string, query: string | null) => void
  onDone: (answer: GuideAnswer) => void
  onError: (message: string, code: string) => void
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** Split an SSE body into its `data:` payloads, in order, however the network chunks it. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frame = (raw: string): string | null => {
    const data: string[] = []
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      data.push(line.slice(5).replace(/^ /, ''))
    }
    return data.length > 0 ? data.join('\n') : null
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const data = frame(buffer.slice(0, sep))
        buffer = buffer.slice(sep + 2)
        if (data !== null) yield data
        sep = buffer.indexOf('\n\n')
      }
    }
    const last = buffer.trim() ? frame(buffer) : null
    if (last !== null) yield last
  } finally {
    reader.releaseLock()
  }
}

interface Frame {
  type?: string
  delta?: string
  toolCallId?: string
  toolCallName?: string
  name?: string
  value?: unknown
  message?: string
  code?: string
}

export async function streamGuideAsk(
  body: AskGuideRequest,
  handlers: GuideAskHandlers,
  signal: AbortSignal
): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${GUIDE_API_ROOT}/ask`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Requested-With': 'fetch',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (isAbort(err) || signal.aborted) return
    throw err
  }
  if (!response.ok || !response.body) {
    const parsed = (await response.json().catch(() => null)) as {
      error?: string
      code?: string
    } | null
    const err = new ApiError({
      error: parsed?.error ?? `The guide could not answer (${response.status})`,
      statusCode: response.status,
      code: parsed?.code,
    })
    if (err.status === 401) notifyUnauthorized(err)
    handlers.onError(err.message, err.code ?? 'error')
    return
  }
  const names = new Map<string, string>()
  try {
    for await (const data of sseData(response.body)) {
      let event: Frame
      try {
        event = JSON.parse(data) as Frame
      } catch {
        continue
      }
      switch (event.type) {
        case 'TEXT_MESSAGE_CONTENT':
          if (typeof event.delta === 'string') handlers.onDelta(event.delta)
          break
        case 'TOOL_CALL_START':
          if (event.toolCallId) names.set(event.toolCallId, event.toolCallName ?? 'search_guide')
          break
        case 'TOOL_CALL_ARGS': {
          let query: string | null = null
          try {
            const args = JSON.parse(event.delta ?? '{}') as { query?: unknown }
            query = typeof args.query === 'string' ? args.query : null
          } catch {
            // A tool input we cannot read is still a step.
          }
          handlers.onProgress(names.get(event.toolCallId ?? '') ?? 'search_guide', query)
          break
        }
        case 'CUSTOM':
          if (event.name === GUIDE_ANSWER_EVENT) {
            const parsed = guideAnswerSchema.safeParse(event.value)
            if (parsed.success) handlers.onDone(parsed.data)
          }
          break
        case 'RUN_ERROR':
          handlers.onError(event.message ?? 'The guide could not answer.', event.code ?? 'error')
          break
        default:
          break
      }
    }
  } catch (err) {
    if (isAbort(err) || signal.aborted) return
    throw err
  }
}
