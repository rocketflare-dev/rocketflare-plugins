/**
 * Where FreeAgent lives for this deployment, and the outbound `fetch` everything uses.
 *
 * Sandbox and production are two hosts with the same paths. A connection remembers the
 * environment it was made in, so changing `FREEAGENT_ENVIRONMENT` never sends a production token
 * to the sandbox: existing connections keep their host and Settings shows the mismatch.
 *
 * `freeagentHttp` is the one place a real `fetch` (and a real timer) is named. Every service takes
 * `deps` defaulting to it, so a unit test passes its own; the API tests that drive the real routes
 * swap `freeagentHttp.fetch` for the length of a test and put it back. No global is stubbed.
 */
import {
  type FreeAgentConfig,
  type FreeAgentEnvironment,
  freeagentConfigSchema,
} from '@rocketflare/shared/plugins/freeagent/index'
import type { PluginConfig } from '@/plugins/api'

export const FREEAGENT_HOSTS: Record<FreeAgentEnvironment, string> = {
  sandbox: 'https://api.sandbox.freeagent.com',
  production: 'https://api.freeagent.com',
}

/** The public mount's callback — what the operator registers as the app's redirect URI. */
export const FREEAGENT_CALLBACK_PATH = '/api/hooks/freeagent/callback'

/** `fetch` as the client calls it. Injected so tests never reach FreeAgent. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface FreeAgentDeps {
  fetch: FetchLike
  /** Waits out a 429's `Retry-After`. Injected so a test does not actually wait. */
  sleep: (ms: number) => Promise<void>
}

/** Unbound `fetch` throws "Illegal invocation" on Workers once it is called as a method. */
export const freeagentHttp: FreeAgentDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** This plugin's slice of the Worker config, parsed (defaults applied). */
export function freeagentConfig(config: PluginConfig): FreeAgentConfig {
  return freeagentConfigSchema.parse(config)
}

export interface FreeAgentAppCredentials {
  clientId: string
  clientSecret: string
}

/** The operator's app, or null when the deployment has not set both secrets. */
export function appCredentials(config: PluginConfig): FreeAgentAppCredentials | null {
  const c = freeagentConfig(config)
  if (!c.FREEAGENT_CLIENT_ID || !c.FREEAGENT_CLIENT_SECRET) return null
  return { clientId: c.FREEAGENT_CLIENT_ID, clientSecret: c.FREEAGENT_CLIENT_SECRET }
}

export function redirectUri(appUrl: string): string {
  return new URL(FREEAGENT_CALLBACK_PATH, appUrl).toString()
}

/** `GET /v2/approve_app` — FreeAgent's consent page, which redirects back with `code` + `state`. */
export function approveUrl(
  environment: FreeAgentEnvironment,
  params: { clientId: string; redirectUri: string; state: string }
): string {
  const url = new URL('/v2/approve_app', FREEAGENT_HOSTS[environment])
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  return url.toString()
}

/** Where the admin lands afterwards: Settings → FreeAgent, with the outcome in the query. */
export function settingsReturnUrl(
  appUrl: string,
  outcome: { connected: true } | { error: string }
): string {
  const url = new URL('/settings', appUrl)
  url.searchParams.set('tab', 'freeagent')
  if ('connected' in outcome) url.searchParams.set('connected', 'freeagent')
  else url.searchParams.set('connectError', outcome.error)
  return url.toString()
}
