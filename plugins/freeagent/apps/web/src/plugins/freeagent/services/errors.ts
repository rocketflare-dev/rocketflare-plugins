/**
 * FreeAgent's failures, read on the server: the status → code map and the error-body reader.
 *
 * `FreeAgentError` and `isFreeAgentError` live in the shared half
 * (`@rocketflare/shared/plugins/freeagent/errors`), because another plugin may test a failure with
 * them and a pure guard needs no organisation; they are re-exported here so the server imports
 * one module.
 */
import {
  FREEAGENT_ERROR_CODES,
  FreeAgentError,
  type FreeAgentErrorCode,
  isFreeAgentError,
} from '@rocketflare/shared/plugins/freeagent/errors'

export { FREEAGENT_ERROR_CODES, FreeAgentError, type FreeAgentErrorCode, isFreeAgentError }

/** The code an HTTP status maps to, for a response that was not OK and not a 429. */
export function codeForStatus(status: number): FreeAgentErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 400 || status === 422) return 'validation'
  if (status >= 500) return 'upstream'
  return 'bad_response'
}

/**
 * FreeAgent's error body, read loosely: `{ errors: { error: { message } } }`,
 * `{ errors: [{ message }] }`, `{ errors: { error: [...] } }`, or OAuth's
 * `{ error, error_description }`. Answers the first human message found, or null.
 */
export function freeagentErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (typeof record.error_description === 'string') return record.error_description
  const messages: string[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || messages.length >= 3) return
    if (typeof value === 'string') return
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1)
      return
    }
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>
      if (typeof v.message === 'string') messages.push(v.message)
      else for (const child of Object.values(v)) visit(child, depth + 1)
    }
  }
  visit(record.errors, 0)
  if (messages.length > 0) return messages.join('; ')
  return typeof record.error === 'string' ? record.error : null
}
