/**
 * The provider contract — what a PROVIDER plugin (`m365`, `google-workspace`) contributes, and the
 * registry that reads it (D31 decision 6, D34).
 *
 * The split is deliberate and it is the whole design: **this plugin owns every row, every route,
 * every cursor, every claim and every schedule; a provider owns only the conversation with its
 * vendor.** A provider never touches the database. It turns a cursor into a page of plain items,
 * a callback query into an external tenant id, credentials into a token — and the engine in
 * `services/sync.ts` does everything else, identically for every vendor. That is what makes the
 * second provider cheap and the isolation proof one proof.
 *
 * A provider writes:
 *
 *     import { connectorExtensions, type ConnectorProvider } from '@/plugins/connectors'
 *     export const m365Server = {
 *       shared: m365Shared,
 *       extensions: connectorExtensions({ providers: [m365Provider] }),
 *     } satisfies ServerPlugin<typeof m365Shared>
 *
 * and declares `requires: { plugins: ['connectors'] }` in its `plugin.json`.
 *
 * **Two token shapes, one interface.** Graph's client-credentials grant mints ONE token per
 * customer tenant that reads every mailbox (`tokenPerSubject: false`, cached on the organisation's
 * connection). Google's domain-wide delegation mints one token PER impersonated person
 * (`tokenPerSubject: true`, cached on each connection) and impersonates an admin for the directory
 * — which is why `mintToken` is handed the subject's email as well as its id, and the installation's
 * provider-specific `settings`.
 *
 * Everything is read LAZILY through `extensions()` — that accessor reads the server barrel, which
 * imports this plugin, so a module-scope read would close a cycle (see analytics' `extensions.ts`).
 */

import {
  connectorExtensions as buildExtensions,
  CONNECTOR_EXTENSION_KEYS,
  type ConnectorResource,
} from '@rocketflare/shared/plugins/connectors/index'
import { z } from 'zod'
import type { PluginConfig, PluginLogger } from '@/plugins/api'
import { extensionSources, extensions } from '@/plugins/api/peers'

export { CONNECTOR_EXTENSION_KEYS }

// ---- What a provider is handed -------------------------------------------------------------------

/** An app's credentials: the operator's (from config) or the organisation's own (BYO, unsealed). */
export interface ConnectorCredentials {
  clientId: string
  clientSecret: string
}

/** The installation, as a provider may see it — no secrets, no row internals. */
export interface InstallationView {
  id: string
  tenantId: string
  externalTenantId: string | null
  appMode: 'operator' | 'byo'
  settings: Readonly<Record<string, unknown>>
}

/** Whose data a call reads. `null` is the organisation (directory); otherwise one person. */
export interface SubjectView {
  externalId: string
  email: string | null
}

/** `fetch` is injected so tests never reach a vendor and no global is stubbed. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Everything one page of a sync is handed. `token()` is cached by the engine; call it per request. */
export interface SourceCtx {
  installation: InstallationView
  token: () => Promise<string>
  fetch: FetchLike
  logger: PluginLogger
}

/**
 * One page. `next` is a page link to continue the SAME pass with; `final` is the delta token a
 * finished pass leaves behind. Exactly one of them is set. `removed` are external ids.
 */
export interface SyncPage<T> {
  items: T[]
  removed: string[]
  next: string | null
  final: string | null
}

/**
 * A directory person. **An absent field means "unchanged"**, not "cleared": Graph's incremental
 * delta rounds send an object's id with only the properties that moved, and treating the rest as
 * null would erase them. `null` is a real value (the person has no mail address).
 */
export interface DirectoryUserItem {
  externalId: string
  email?: string | null
  displayName?: string | null
  jobTitle?: string | null
  accountEnabled?: boolean
}

/** A directory group — absent fields unchanged, exactly as for `DirectoryUserItem`. */
export interface DirectoryGroupItem {
  externalId: string
  displayName?: string | null
  email?: string | null
  description?: string | null
  /**
   * `delta` — Graph's `members@delta`: additions and removals since the last page.
   * `replace` — the whole membership (a provider without membership deltas lists it).
   * Absent — membership unchanged on this page.
   */
  members?:
    | { mode: 'delta'; added: string[]; removed: string[] }
    | { mode: 'replace'; userExternalIds: string[] }
}

export interface CalendarEventItem {
  externalId: string
  title: string
  startsAt: Date
  endsAt: Date
  isAllDay: boolean
  location: string | null
  organizerEmail: string | null
  organizerName: string | null
  attendees: { email: string | null; name: string | null; response: string | null }[]
  webLink: string | null
  isCancelled: boolean
}

/** The window a calendar pass covers. A delta chain is bound to the window it started with. */
export interface CalendarWindow {
  start: Date
  end: Date
}

export interface DirectorySource {
  users(ctx: SourceCtx, cursor: string | null): Promise<SyncPage<DirectoryUserItem>>
  groups(ctx: SourceCtx, cursor: string | null): Promise<SyncPage<DirectoryGroupItem>>
}

export interface CalendarSource {
  events(
    ctx: SourceCtx & { subject: SubjectView; window: CalendarWindow },
    cursor: string | null
  ): Promise<SyncPage<CalendarEventItem>>
  /** Days before and after "now" a fresh pass covers. */
  windowDays: { past: number; future: number }
  /**
   * How long one delta chain may live before the engine forces a full pass with a fresh window —
   * the window is fixed when the chain starts, so without this "the next 90 days" slowly becomes
   * "the 90 days after the day we connected".
   */
  maxChainDays: number
}

export interface ConsentResult {
  externalTenantId: string
  displayName?: string | null
}

export interface MintedToken {
  accessToken: string
  expiresAt: Date
  /** What the vendor says this token may do (Graph `roles`, Google `scope`). */
  scopes: string[]
}

export interface ConnectorProvider {
  /** A plugin id (`m365`); the `:provider` in every route and the `provider` column. */
  id: string
  label: string
  description: string
  docsUrl: string | null
  adminSteps: readonly string[]
  operatorSteps: readonly string[]
  permissions: readonly { scope: string; reason: string }[]
  supportsByo: boolean
  /** Graph client credentials: false (one org token). Google DWD: true (one token per person). */
  tokenPerSubject: boolean
  /** The deployment's own app, from config — null when the operator has not registered one. */
  operatorCredentials(config: PluginConfig): ConnectorCredentials | null
  /** Where the admin is sent. `state` is already signed; hand it back verbatim. */
  consentUrl(input: {
    credentials: ConnectorCredentials
    redirectUri: string
    state: string
  }): string
  /**
   * The callback's query string, with `state` already verified. Throw `ConsentError` for a
   * refusal (the admin pressed Cancel, consent was not granted).
   */
  completeConsent(input: { query: URLSearchParams }): ConsentResult
  mintToken(input: {
    credentials: ConnectorCredentials
    installation: InstallationView
    subject: SubjectView | null
    fetch: FetchLike
  }): Promise<MintedToken>
  directory: DirectorySource
  calendar?: CalendarSource
}

// ---- What a provider throws ----------------------------------------------------------------------

/** The delta token is gone (Graph 410 / `syncStateNotFound`, Google 410): start a full pass. */
export class CursorExpiredError extends Error {
  constructor(message = 'The sync cursor has expired') {
    super(message)
    this.name = 'CursorExpiredError'
  }
}

/** Throttled (429 / 503 with `Retry-After`): try again later, without counting it a failure. */
export class RetryLaterError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Throttled by the provider'
  ) {
    super(message)
    this.name = 'RetryLaterError'
  }
}

/**
 * The app itself is refused — consent revoked, secret expired, the app deleted. Retrying cannot
 * help; the installation goes to `error` and an admin has to act.
 */
export class ConnectorAuthError extends Error {
  constructor(
    message: string,
    readonly code = 'connector_auth_failed'
  ) {
    super(message)
    this.name = 'ConnectorAuthError'
  }
}

/** The admin-consent round trip came back without consent. */
export class ConsentError extends Error {
  constructor(
    message: string,
    readonly code = 'consent_not_granted'
  ) {
    super(message)
    this.name = 'ConsentError'
  }
}

/**
 * Build the `extensions` record for a provider plugin's `ServerPlugin`, typed. The untyped builder
 * in the shared half is what a provider should call at MODULE scope (see its note on the cycle);
 * this one is the same function with the contract checked, for anywhere else.
 */
export function connectorExtensions(contribution: {
  providers: readonly ConnectorProvider[]
}): Record<string, readonly unknown[]> {
  return buildExtensions(contribution)
}

// ---- The registry ----------------------------------------------------------------------------------

const fn = z.custom<(...args: never[]) => unknown>(v => typeof v === 'function', {
  message: 'expected a function',
})

/** Structural: the fields the engine reads. The rest passes through untouched. */
const providerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    description: z.string(),
    tokenPerSubject: z.boolean(),
    supportsByo: z.boolean(),
    operatorCredentials: fn,
    consentUrl: fn,
    completeConsent: fn,
    mintToken: fn,
    directory: z.object({ users: fn, groups: fn }).passthrough(),
    calendar: z
      .object({
        events: fn,
        windowDays: z.object({ past: z.number().int().min(0), future: z.number().int().min(1) }),
        maxChainDays: z.number().int().min(1),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

let cached: Map<string, ConnectorProvider> | null = null

/**
 * Every contributed provider, keyed by id — or a throw naming the contributing plugins, at first
 * use, for anything unusable or duplicated. Memoised per isolate: contributions are module-scope
 * constants.
 */
export function connectorProviders(): ReadonlyMap<string, ConnectorProvider> {
  if (cached) return cached
  const key = CONNECTOR_EXTENSION_KEYS.providers
  const out = new Map<string, ConnectorProvider>()
  for (const [index, value] of extensions(key).entries()) {
    const parsed = providerSchema.safeParse(value)
    const from = extensionSources(key).join(', ') || 'an installed plugin'
    if (!parsed.success) {
      throw new Error(
        `${key}[${index}] from ${from} is unusable: ` +
          parsed.error.issues.map(i => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')
      )
    }
    const provider = value as ConnectorProvider
    if (out.has(provider.id))
      throw new Error(`${key}: provider "${provider.id}" is contributed twice`)
    out.set(provider.id, provider)
  }
  cached = out
  return out
}

/** One provider, or undefined when no installed plugin contributes it. */
export function connectorProvider(id: string): ConnectorProvider | undefined {
  return connectorProviders().get(id)
}

/** Which resources a provider syncs — derived, so the list can never disagree with the sources. */
export function providerResources(provider: ConnectorProvider): ConnectorResource[] {
  return provider.calendar ? ['users', 'groups', 'calendar'] : ['users', 'groups']
}

/**
 * Tests only: replace the registry with fixture providers (`null` restores the real one). The
 * plugin's own suite runs whether or not any provider plugin is installed beside it, so it proves
 * the engine against a fake vendor rather than depending on `m365` being present.
 */
export function setConnectorProvidersForTests(
  providers: readonly ConnectorProvider[] | null
): void {
  cached = providers ? new Map(providers.map(p => [p.id, p])) : null
}
