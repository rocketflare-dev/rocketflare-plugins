/**
 * `FreeAgentError` — every way talking to FreeAgent can fail, as ONE typed error with a code.
 *
 * Callers branch on `code`, never on a message: the sync decides retry-or-stop from it, the routes
 * map it to a status, and a tool turns it into a hint the model can act on. The message is safe to
 * show and to log — it never carries a token, a code or a client secret, because nothing that
 * builds one puts them in.
 */

export const FREEAGENT_ERROR_CODES = [
  /** The deployment has no FreeAgent app (`FREEAGENT_CLIENT_ID` / `_SECRET`). */
  'not_configured',
  /** This organisation has no connection. */
  'not_connected',
  /** FreeAgent refused the refresh token (`invalid_grant`): an admin must reconnect. */
  'needs_reconnect',
  /** The token endpoint said `invalid_grant` — internal; surfaced to callers as `needs_reconnect`. */
  'invalid_grant',
  /** 429 after the bounded back-off; `retryAfterSeconds` says when. */
  'rate_limited',
  'unauthorized',
  'forbidden',
  'not_found',
  /** 422 / 400: FreeAgent rejected what we sent. The message is FreeAgent's. */
  'validation',
  /** 5xx. */
  'upstream',
  /** The request never got an answer. */
  'network',
  /** An answer we could not read, or a URL outside the connection's API host. */
  'bad_response',
] as const
export type FreeAgentErrorCode = (typeof FREEAGENT_ERROR_CODES)[number]

export class FreeAgentError extends Error {
  readonly code: FreeAgentErrorCode
  readonly status: number | null
  readonly retryAfterSeconds: number | null

  constructor(
    code: FreeAgentErrorCode,
    message: string,
    opts: { status?: number | null; retryAfterSeconds?: number | null } = {}
  ) {
    super(message)
    this.name = 'FreeAgentError'
    this.code = code
    this.status = opts.status ?? null
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null
  }
}

export function isFreeAgentError(err: unknown, code?: FreeAgentErrorCode): err is FreeAgentError {
  return err instanceof FreeAgentError && (code === undefined || err.code === code)
}

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
