/**
 * The Microsoft Graph and Entra token calls, with Microsoft's failure modes mapped onto the
 * engine's three instructions (see `connectors`' `services/sync.ts`):
 *
 * - **throttled** — 429, 503, 504, with `Retry-After` when Graph sends one → `RetryLaterError`.
 *   Every request also says `x-ms-throttle-priority: low`: this is background sync, and Graph
 *   sheds low-priority traffic first rather than a user-facing app's.
 * - **cursor gone** — 410 Gone, or a `syncStateNotFound` / `resyncRequired` error on a delta link
 *   → `CursorExpiredError`, and the engine starts a full pass.
 * - **the app is refused** — the token endpoint says the client is unknown in that tenant (consent
 *   revoked), the secret is invalid or expired, or the tenant is gone; Graph answers 401/403 to a
 *   directory read → `ConnectorAuthError`, and the installation goes to `error` for an admin.
 *
 * Page links come back from Graph as absolute URLs and are stored as cursors. **A bearer token is
 * only ever sent to `graph.microsoft.com`**: a cursor naming any other host is refused, so a row
 * edited by hand (or a poisoned response) cannot exfiltrate the tenant-wide token.
 */
import {
  ConnectorAuthError,
  CursorExpiredError,
  type FetchLike,
  RetryLaterError,
} from '@/plugins/connectors'

export const GRAPH_ORIGIN = 'https://graph.microsoft.com'
export const LOGIN_ORIGIN = 'https://login.microsoftonline.com'
export const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default'
/** When Graph throttles without saying for how long. */
const DEFAULT_RETRY_SECONDS = 30

/** Error codes on a delta request that mean "this token is no longer usable — start again". */
const CURSOR_GONE_CODES = new Set([
  'syncStateNotFound',
  'SyncStateNotFound',
  'resyncRequired',
  'ResyncRequired',
  'SyncStateInvalid',
])

/** AADSTS codes that mean the APP is refused in that tenant, not that the request was bad. */
const APP_REFUSED = [
  'AADSTS700016', // application not found in the directory — consent revoked, or never granted
  'AADSTS7000215', // invalid client secret
  'AADSTS7000222', // client secret expired
  'AADSTS7000229', // the tenant has no service principal for the app — consent never completed
  'AADSTS65001', // consent not granted
  'AADSTS90002', // tenant not found
  'AADSTS500011', // resource principal not found in the tenant
]

interface GraphError {
  error?: { code?: string; message?: string }
}

function retryAfter(res: Response): number {
  const header = res.headers.get('retry-after')
  if (!header) return DEFAULT_RETRY_SECONDS
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : DEFAULT_RETRY_SECONDS
}

async function errorBody(res: Response): Promise<GraphError> {
  try {
    return (await res.json()) as GraphError
  } catch {
    return {}
  }
}

/** Resolve a stored cursor or a path to a Graph URL — and refuse anything that is not Graph. */
export function graphUrl(pathOrLink: string): URL {
  const url = new URL(pathOrLink, GRAPH_ORIGIN)
  if (url.origin !== GRAPH_ORIGIN) {
    throw new Error(`Refusing to send a Graph token to ${url.origin}`)
  }
  return url
}

export type GraphAccess = 'directory' | 'mailbox'

/**
 * GET one Graph page. `access` decides what a 401/403 means: for the DIRECTORY it is the app's
 * permission (an admin must act → `ConnectorAuthError`); for one MAILBOX it is that mailbox
 * (an RBAC-for-Applications scope excluding it, no Exchange licence) and must not take the whole
 * installation down, so it is an ordinary failure recorded on that one cursor.
 */
export async function graphGet<T>(
  fetch: FetchLike,
  token: string,
  pathOrLink: string,
  access: GraphAccess,
  headers: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(graphUrl(pathOrLink).toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'x-ms-throttle-priority': 'low',
      ...headers,
    },
  })
  if (res.ok) return (await res.json()) as T
  if (res.status === 429 || res.status === 503 || res.status === 504) {
    throw new RetryLaterError(
      retryAfter(res),
      `Microsoft Graph throttled the request (${res.status})`
    )
  }
  const body = await errorBody(res)
  const code = body.error?.code ?? ''
  if (res.status === 410 || CURSOR_GONE_CODES.has(code)) {
    throw new CursorExpiredError(
      `Microsoft Graph discarded the delta token (${code || res.status})`
    )
  }
  const detail = `${res.status}${code ? ` ${code}` : ''}: ${body.error?.message ?? res.statusText}`
  if ((res.status === 401 || res.status === 403) && access === 'directory') {
    throw new ConnectorAuthError(
      `Microsoft Graph refused the directory read (${detail}). Re-grant admin consent.`,
      'm365_permission_denied'
    )
  }
  throw new Error(`Microsoft Graph request failed (${detail})`)
}

export interface TokenResponse {
  access_token: string
  expires_in: number
}

/**
 * The client-credentials grant against ONE customer tenant: an app-only token for everything the
 * admin consented to, for about an hour. No refresh token exists in this flow — the engine simply
 * mints another before this one runs out.
 */
export async function clientCredentialsToken(
  fetch: FetchLike,
  input: { tenant: string; clientId: string; clientSecret: string }
): Promise<TokenResponse> {
  const res = await fetch(`${LOGIN_ORIGIN}/${encodeURIComponent(input.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      scope: GRAPH_DEFAULT_SCOPE,
      grant_type: 'client_credentials',
    }).toString(),
  })
  if (res.ok) return (await res.json()) as TokenResponse
  if (res.status === 429 || res.status >= 500) {
    throw new RetryLaterError(retryAfter(res), `Microsoft Entra is unavailable (${res.status})`)
  }
  let body: { error?: string; error_description?: string; error_codes?: number[] } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {}
  const description = body.error_description ?? ''
  // Only the first line: the rest is a trace id and a timestamp, noise in a status view.
  const summary = description.split(/\r?\n/)[0]?.trim() || body.error || String(res.status)
  if (
    body.error === 'invalid_client' ||
    body.error === 'unauthorized_client' ||
    APP_REFUSED.some(code => description.includes(code))
  ) {
    throw new ConnectorAuthError(`Microsoft Entra refused the app: ${summary}`, 'm365_app_refused')
  }
  throw new Error(`Microsoft Entra token request failed: ${summary}`)
}

/**
 * The `roles` claim of an app-only token — the application permissions the tenant actually
 * granted. Read without verifying: it is our own token, fresh from the token endpoint over TLS, and
 * it is only displayed; Graph enforces the real thing.
 */
export function tokenRoles(accessToken: string): string[] {
  const payload = accessToken.split('.')[1]
  if (!payload) return []
  try {
    const json = JSON.parse(
      atob(
        payload
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil(payload.length / 4) * 4, '=')
      )
    ) as { roles?: unknown }
    return Array.isArray(json.roles)
      ? json.roles.filter((r): r is string => typeof r === 'string')
      : []
  } catch {
    return []
  }
}
