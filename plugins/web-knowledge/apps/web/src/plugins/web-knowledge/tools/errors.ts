/**
 * Every dead end as `{ error, hint }` — a tool that only says "failed" makes a model retry blindly
 * or invent. The hint says what to do next, and for a rejected key that is "tell the person".
 */
import { WebSearchError } from '../services/providers'

export interface ToolFailure {
  error: string
  message: string
  hint: string
}

const HINTS: Record<WebSearchError['code'], string> = {
  key_rejected:
    'The organisation’s web search key was rejected. Do not retry. Tell the user an admin must ' +
    'update the key in Settings → Web search, and answer from what you already know.',
  rate_limited:
    'The search provider’s rate limit or quota is used up. Do not search again in this turn; ' +
    'answer from what you have and say the web could not be searched.',
  timeout: 'The request timed out. Try once more, or answer without it.',
  provider_error: 'The request failed. Try a different query or page once, or answer without it.',
}

export function toolFailure(err: unknown, fallbackMessage: string): string {
  const failure: ToolFailure =
    err instanceof WebSearchError
      ? { error: `web_${err.code}`, message: err.message, hint: HINTS[err.code] }
      : {
          error: 'web_search_unavailable',
          message: fallbackMessage,
          hint: 'Web access is unavailable right now. Answer without it and say so.',
        }
  return JSON.stringify(failure)
}
