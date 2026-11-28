/**
 * `FreeAgentError` — every way talking to FreeAgent can fail, as ONE typed error with a code.
 *
 * In the shared half because it reads no organisation and imports nothing: another plugin tests a
 * failure with `isFreeAgentError(err, 'needs_reconnect')`, and a pure guard needs no kill switch
 * (`definePublic`). The server's `services/errors.ts` re-exports it, so there is one class and
 * `instanceof` holds wherever it was imported from.
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
