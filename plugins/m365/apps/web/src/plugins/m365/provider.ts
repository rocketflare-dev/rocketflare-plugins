/**
 * Microsoft 365 as a `ConnectorProvider` (D34, phase 1: directory + calendar, org-wide, app-only).
 *
 * - **Consent** — the Entra admin-consent endpoint on `/organizations`: a Global Administrator (or
 *   Privileged Role Administrator) of the customer tenant grants the deployment's multi-tenant app
 *   its APPLICATION permissions, and Entra redirects back with `admin_consent=True&tenant=<guid>`.
 * - **Tokens** — client credentials against that tenant: one app-only token reads every mailbox,
 *   so `tokenPerSubject` is false and the engine caches it once, on the organisation's connection.
 * - **Directory** — `users/delta` and `groups/delta` (with `members@delta`), `$select`ed down to
 *   what the tables hold.
 * - **Calendar** — `users/{id}/calendarView/delta` over a rolling window, in UTC. A delta chain is
 *   bound to the window it began with, so `maxChainDays` makes the engine start a fresh window
 *   weekly; otherwise "the next 90 days" drifts into the past.
 *
 * Nothing here touches the database, and nothing here holds state: every call is handed what it
 * needs, which is what makes this file testable with nothing but an injected `fetch`.
 */
import {
  type CalendarEventItem,
  type ConnectorProvider,
  ConsentError,
  type DirectoryGroupItem,
  type DirectoryUserItem,
  type SyncPage,
} from '@/plugins/connectors'
import {
  clientCredentialsToken,
  GRAPH_DEFAULT_SCOPE,
  graphGet,
  LOGIN_ORIGIN,
  tokenRoles,
} from './graph'

/** Delta pages Graph may send at once; it may send fewer. */
const PAGE_SIZE = 100
/** An Entra tenant id is a GUID; anything else in the callback is not one we asked about. */
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const USER_SELECT = 'id,displayName,mail,userPrincipalName,jobTitle,accountEnabled'
const GROUP_SELECT = 'id,displayName,mail,description,members'

interface GraphPage<T> {
  value: T[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

interface Removed {
  '@removed'?: { reason?: string }
}

interface GraphUser extends Removed {
  id: string
  displayName?: string | null
  mail?: string | null
  userPrincipalName?: string | null
  jobTitle?: string | null
  accountEnabled?: boolean | null
}

interface GraphMember extends Removed {
  '@odata.type'?: string
  id: string
}

interface GraphGroup extends Removed {
  id: string
  displayName?: string | null
  mail?: string | null
  description?: string | null
  'members@delta'?: GraphMember[]
}

interface GraphDateTime {
  dateTime: string
  timeZone?: string
}

interface GraphEmail {
  emailAddress?: { name?: string | null; address?: string | null }
}

interface GraphEvent extends Removed {
  id: string
  subject?: string | null
  start?: GraphDateTime
  end?: GraphDateTime
  isAllDay?: boolean
  isCancelled?: boolean
  location?: { displayName?: string | null }
  organizer?: GraphEmail
  attendees?: (GraphEmail & { status?: { response?: string | null } })[]
  webLink?: string | null
}

function page<T>(raw: GraphPage<unknown>, items: T[], removed: string[]): SyncPage<T> {
  return {
    items,
    removed,
    next: raw['@odata.nextLink'] ?? null,
    final: raw['@odata.nextLink'] ? null : (raw['@odata.deltaLink'] ?? null),
  }
}

/** Only keys Graph actually sent — an absent key is "unchanged" on an incremental round. */
function has<T extends object>(obj: T, key: keyof T): boolean {
  return Object.hasOwn(obj, key)
}

/**
 * A person's address: `mail`, else a UPN that is a real address. A guest's UPN
 * (`name_contoso.com#EXT#@tenant.onmicrosoft.com`) is not one, and matching on it would never
 * find the member it belongs to.
 */
export function userEmail(user: Pick<GraphUser, 'mail' | 'userPrincipalName'>): string | null {
  if (user.mail) return user.mail
  const upn = user.userPrincipalName
  return upn && !upn.includes('#EXT#') ? upn : null
}

export function toDirectoryUser(user: GraphUser): DirectoryUserItem {
  const item: DirectoryUserItem = { externalId: user.id }
  if (has(user, 'mail') || has(user, 'userPrincipalName')) item.email = userEmail(user)
  if (has(user, 'displayName')) item.displayName = user.displayName ?? null
  if (has(user, 'jobTitle')) item.jobTitle = user.jobTitle ?? null
  if (has(user, 'accountEnabled')) item.accountEnabled = user.accountEnabled !== false
  return item
}

export function toDirectoryGroup(group: GraphGroup): DirectoryGroupItem {
  const item: DirectoryGroupItem = { externalId: group.id }
  if (has(group, 'displayName')) item.displayName = group.displayName ?? null
  if (has(group, 'mail')) item.email = group.mail ?? null
  if (has(group, 'description')) item.description = group.description ?? null
  const delta = group['members@delta']
  if (delta) {
    // People only: nested groups, devices and service principals are not directory users here.
    const people = delta.filter(
      m => !m['@odata.type'] || m['@odata.type'] === '#microsoft.graph.user'
    )
    item.members = {
      mode: 'delta',
      added: people.filter(m => !m['@removed']).map(m => m.id),
      removed: people.filter(m => m['@removed']).map(m => m.id),
    }
  }
  return item
}

/** Graph's `dateTime` has no offset; with `Prefer: outlook.timezone="UTC"` it IS UTC. */
function utc(value: GraphDateTime | undefined): Date | null {
  if (!value?.dateTime) return null
  const zone = (value.timeZone ?? 'UTC').toUpperCase()
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value.dateTime)
    ? value.dateTime
    : `${value.dateTime}${zone === 'UTC' ? 'Z' : ''}`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

export function toCalendarEvent(event: GraphEvent): CalendarEventItem | null {
  const startsAt = utc(event.start)
  const endsAt = utc(event.end)
  if (!startsAt || !endsAt) return null
  return {
    externalId: event.id,
    title: event.subject ?? '',
    startsAt,
    endsAt,
    isAllDay: event.isAllDay === true,
    location: event.location?.displayName || null,
    organizerEmail: event.organizer?.emailAddress?.address ?? null,
    organizerName: event.organizer?.emailAddress?.name ?? null,
    attendees: (event.attendees ?? []).map(a => ({
      email: a.emailAddress?.address ?? null,
      name: a.emailAddress?.name ?? null,
      response: a.status?.response ?? null,
    })),
    webLink: event.webLink ?? null,
    isCancelled: event.isCancelled === true,
  }
}

export const m365Provider: ConnectorProvider = {
  id: 'm365',
  label: 'Microsoft 365',
  description:
    'Your organisation’s Entra ID directory (people and groups) and your members’ Outlook calendars.',
  docsUrl: 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent',
  adminSteps: [
    'Sign in here as an organisation admin and press Connect Microsoft 365.',
    'Microsoft asks a Global Administrator (or Privileged Role Administrator) of your Microsoft 365 tenant to consent to the permissions below. Accept.',
    'You are brought back here. The directory syncs first; calendars follow for people who are members of this app, matched by email.',
    'To disconnect later, press Disconnect here AND remove the app under Entra admin center → Enterprise applications.',
  ],
  operatorSteps: [
    'Entra admin center → App registrations → New registration. Supported account types: "Accounts in any organizational directory (multitenant)".',
    'Redirect URI (Web): <APP_URL>/api/hooks/connectors/m365/callback — one per environment.',
    'API permissions → Microsoft Graph → Application permissions: User.Read.All, Group.Read.All, Calendars.Read. Do not grant consent in your own tenant unless you use it too.',
    'Certificates & secrets → New client secret (max 24 months — diarise the rotation).',
    'Set the secrets M365_CLIENT_ID and M365_CLIENT_SECRET: `pnpm provision secrets <env>`, or apps/web/.dev.vars locally.',
    'Before selling to other organisations, complete publisher verification (Branding & properties → Publisher domain, then a verified Microsoft AI Cloud Partner Program account).',
  ],
  permissions: [
    { scope: 'User.Read.All', reason: 'people in the directory, to match them to members' },
    { scope: 'Group.Read.All', reason: 'groups and their memberships' },
    { scope: 'Calendars.Read', reason: 'the calendars of members who use this app' },
  ],
  supportsByo: true,
  tokenPerSubject: false,

  operatorCredentials(config) {
    const { M365_CLIENT_ID: clientId, M365_CLIENT_SECRET: clientSecret } = config as {
      M365_CLIENT_ID?: string
      M365_CLIENT_SECRET?: string
    }
    return clientId && clientSecret ? { clientId, clientSecret } : null
  },

  consentUrl({ credentials, redirectUri, state }) {
    const url = new URL(`${LOGIN_ORIGIN}/organizations/v2.0/adminconsent`)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('scope', GRAPH_DEFAULT_SCOPE)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return url.toString()
  },

  completeConsent({ query }) {
    const error = query.get('error')
    if (error) {
      // `access_denied` is the admin pressing Cancel; `consent_required` a non-admin who tried.
      const description = query.get('error_description') ?? ''
      throw new ConsentError(
        description.split(/\r?\n/)[0] || error,
        error === 'access_denied' ? 'consent_not_granted' : 'admin_consent_required'
      )
    }
    if (query.get('admin_consent')?.toLowerCase() !== 'true') {
      throw new ConsentError('Microsoft did not report admin consent', 'consent_not_granted')
    }
    const tenant = query.get('tenant') ?? ''
    if (!TENANT_ID_RE.test(tenant)) {
      throw new ConsentError('Microsoft returned no tenant id', 'consent_not_granted')
    }
    return { externalTenantId: tenant.toLowerCase() }
  },

  async mintToken({ credentials, installation, fetch }) {
    if (!installation.externalTenantId)
      throw new Error('The installation has no Entra tenant id yet')
    const token = await clientCredentialsToken(fetch, {
      tenant: installation.externalTenantId,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })
    return {
      accessToken: token.access_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      scopes: tokenRoles(token.access_token).sort(),
    }
  },

  directory: {
    async users(ctx, cursor) {
      const raw = await graphGet<GraphPage<GraphUser>>(
        ctx.fetch,
        await ctx.token(),
        cursor ?? `/v1.0/users/delta?$select=${USER_SELECT}`,
        'directory',
        { Prefer: `odata.maxpagesize=${PAGE_SIZE}` }
      )
      const live = raw.value.filter(u => !u['@removed'])
      const gone = raw.value.filter(u => u['@removed']).map(u => u.id)
      return page(raw, live.map(toDirectoryUser), gone)
    },
    async groups(ctx, cursor) {
      const raw = await graphGet<GraphPage<GraphGroup>>(
        ctx.fetch,
        await ctx.token(),
        cursor ?? `/v1.0/groups/delta?$select=${GROUP_SELECT}`,
        'directory',
        { Prefer: `odata.maxpagesize=${PAGE_SIZE}` }
      )
      const live = raw.value.filter(g => !g['@removed'])
      const gone = raw.value.filter(g => g['@removed']).map(g => g.id)
      return page(raw, live.map(toDirectoryGroup), gone)
    },
  },

  calendar: {
    windowDays: { past: 30, future: 90 },
    maxChainDays: 7,
    async events(ctx, cursor) {
      const first = new URL(
        `/v1.0/users/${encodeURIComponent(ctx.subject.externalId)}/calendarView/delta`,
        'https://graph.microsoft.com'
      )
      first.searchParams.set('startDateTime', ctx.window.start.toISOString())
      first.searchParams.set('endDateTime', ctx.window.end.toISOString())
      const raw = await graphGet<GraphPage<GraphEvent>>(
        ctx.fetch,
        await ctx.token(),
        cursor ?? `${first.pathname}${first.search}`,
        'mailbox',
        { Prefer: `outlook.timezone="UTC", odata.maxpagesize=${PAGE_SIZE}` }
      )
      const items: CalendarEventItem[] = []
      const removed: string[] = []
      for (const event of raw.value) {
        if (event['@removed']) {
          removed.push(event.id)
          continue
        }
        const item = toCalendarEvent(event)
        if (item) items.push(item)
      }
      return page(raw, items, removed)
    },
  },
}
