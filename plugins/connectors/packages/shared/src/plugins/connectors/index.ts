/**
 * `connectors` — an organisation connects its whole Microsoft 365 or Google Workspace to the app
 * (D34, kit `docs/CONNECTORS.md`). Shared half: the contracts, the sync job and the plugin itself.
 *
 * This is NOT login. The kit's arctic providers sign ONE person in with `openid email profile`;
 * a connection is an ADMIN granting the app access to the organisation's directory and calendars,
 * through an app the deployment's operator registered once (an Entra multi-tenant app, a Google
 * service account with domain-wide delegation). This plugin owns everything provider-neutral —
 * installations, connections, sync cursors, the synced rows, the routes, the Settings tab — and a
 * PROVIDER plugin (`m365`, later `google-workspace`) contributes one `ConnectorProvider` through
 * `extensions`. Installing this plugin alone gives an empty Connections tab; that is correct.
 *
 * **Everything it keys carries the plugin's id**: tables `connectors_*`, the job
 * `connectors.sync`, `/api/connectors` and `/api/hooks/connectors`, query-key roots
 * `connectors:…`, the CLI command `rocketflare connectors`, activity `connectors.…`.
 *
 * **This module never imports a composer at runtime** — see the kit's `plugins/CLAUDE.md`.
 */
import { z } from 'zod'
import type { FeatureDefinition } from '../api'
import { paginatedResponse, paginationQuerySchema } from '../api'
import type { SharedPlugin } from '../types'

/** The plugin's id — and the namespace for every key below. */
export const CONNECTORS_ID = 'connectors'

/**
 * The flag gating the mount, the nav item and the cron (D30). On by default: installing the plugin
 * is the decision to ship it, and the flag is the per-tenant kill switch.
 */
export const CONNECTORS_FLAG = 'connectors'

/** Admin-level roles manage connections; `support` may read their status, never the data. */
export const CONNECTOR_SUBJECT = 'Connector'

/** The one job: advance ONE sync cursor by up to a few pages. */
export const CONNECTORS_SYNC_JOB = 'connectors.sync'

/**
 * The `extensions` key a provider plugin contributes its `ConnectorProvider` under, and the helper
 * that builds the record. They live HERE, in the shared half, rather than beside the provider
 * contract on the server, for a reason that is not style: a provider calls this at MODULE scope
 * (`extensions: connectorExtensions({ providers: [...] })`), and the server entry of this plugin
 * sits on the cycle through the server barrel — so reaching it from a provider's module scope can
 * find it half-evaluated, depending on which module the process entered through. The shared half
 * is a leaf; importing it can never close that cycle. The provider TYPE stays on the server entry.
 */
export const CONNECTOR_EXTENSION_KEYS = { providers: `${CONNECTORS_ID}:providers` } as const

export function connectorExtensions(contribution: {
  providers: readonly unknown[]
}): Record<string, readonly unknown[]> {
  return { [CONNECTOR_EXTENSION_KEYS.providers]: contribution.providers }
}

/** Query-key roots, and the `entity.changed` entities the server nudges. */
export const CONNECTORS_INSTALLATIONS_ENTITY = 'connectors:installations'
export const CONNECTORS_EVENTS_ENTITY = 'connectors:events'

// ---- Vocabulary ---------------------------------------------------------------------------------

/**
 * What a cursor syncs. `users` and `groups` ride the organisation's own connection; `calendar`
 * rides one connection per mailbox. Stored as text, so a new resource (`mail`, `files`) in a later
 * phase is not a migration.
 */
export const CONNECTOR_RESOURCES = ['users', 'groups', 'calendar'] as const
export const connectorResourceSchema = z.enum(CONNECTOR_RESOURCES)
export type ConnectorResource = z.infer<typeof connectorResourceSchema>

export const INSTALLATION_STATUSES = ['pending', 'active', 'error'] as const
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number]

/**
 * `operator` — the deployment's own registered app (the default). `byo` — the organisation
 * registered its own app and pastes its credentials here; for regulated tenants, and the way round
 * Google's verification for an Internal app.
 */
export const APP_MODES = ['operator', 'byo'] as const
export const appModeSchema = z.enum(APP_MODES)
export type AppMode = z.infer<typeof appModeSchema>

/** Provider ids are plugin-contributed, so the contract is a shape, not an enum. */
export const connectorProviderIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(40)

// ---- Contracts ----------------------------------------------------------------------------------

/** What a provider tells the Connections tab about itself — pure data, from the registry. */
export const connectorProviderInfoSchema = z.object({
  id: connectorProviderIdSchema,
  label: z.string(),
  description: z.string(),
  /** Whether this deployment's operator has configured its app (the `*_CLIENT_ID` secrets). */
  operatorConfigured: z.boolean(),
  supportsByo: z.boolean(),
  resources: z.array(connectorResourceSchema),
  /** Numbered steps for the organisation's admin, and for the operator who registers the app. */
  adminSteps: z.array(z.string()),
  operatorSteps: z.array(z.string()),
  /** The permissions the admin is asked to consent to, and why each is needed. */
  permissions: z.array(z.object({ scope: z.string(), reason: z.string() })),
  docsUrl: z.string().url().nullable(),
})
export type ConnectorProviderInfo = z.infer<typeof connectorProviderInfoSchema>

export const connectorProviderListResponseSchema = z.object({
  items: z.array(connectorProviderInfoSchema),
})

/** One cursor's progress, as the status view shows it. */
export const syncCursorStatusSchema = z.object({
  resource: connectorResourceSchema,
  /** Cursors of this resource (one per mailbox for `calendar`). */
  count: z.number().int(),
  /** Still paging through a first (or forced) full sync. */
  backfilling: z.number().int(),
  lastSyncedAt: z.coerce.date().nullable(),
  failing: z.number().int(),
  lastError: z.string().nullable(),
})
export type SyncCursorStatus = z.infer<typeof syncCursorStatusSchema>

/** An installation, as every consumer sees it. Credentials are `hasCredential`, never a value. */
export const connectorInstallationSchema = z.object({
  id: z.string().uuid(),
  provider: connectorProviderIdSchema,
  status: z.enum(INSTALLATION_STATUSES),
  appMode: appModeSchema,
  hasCredential: z.boolean(),
  /** The Entra tenant id / Google customer id the admin connected. */
  externalTenantId: z.string().nullable(),
  displayName: z.string().nullable(),
  grantedScopes: z.array(z.string()),
  installedAt: z.coerce.date().nullable(),
  lastError: z.string().nullable(),
  counts: z.object({
    users: z.number().int(),
    matchedUsers: z.number().int(),
    groups: z.number().int(),
    mailboxes: z.number().int(),
    events: z.number().int(),
  }),
  cursors: z.array(syncCursorStatusSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type ConnectorInstallation = z.infer<typeof connectorInstallationSchema>

export const connectorInstallationListResponseSchema = z.object({
  items: z.array(connectorInstallationSchema),
})

const SECRET_MAX = 1_000

/**
 * `POST /api/connectors/installations` — start (or restart) the consent round trip. `byo` needs
 * the organisation's own client id and secret; `operator` needs nothing but the provider.
 */
export const startInstallationRequestSchema = z
  .object({
    provider: connectorProviderIdSchema,
    appMode: appModeSchema.default('operator'),
    clientId: z.string().trim().min(1).max(200).optional(),
    clientSecret: z.string().trim().min(1).max(SECRET_MAX).optional(),
  })
  .refine(b => b.appMode === 'operator' || (b.clientId && b.clientSecret), {
    message: 'A bring-your-own app needs its client id and secret',
    path: ['clientId'],
  })
export type StartInstallationRequest = z.infer<typeof startInstallationRequestSchema>

/** Where the browser goes next: the provider's admin-consent page. */
export const startInstallationResponseSchema = z.object({
  installationId: z.string().uuid(),
  consentUrl: z.string().url(),
})
export type StartInstallationResponse = z.infer<typeof startInstallationResponseSchema>

export const syncInstallationRequestSchema = z.object({
  resource: connectorResourceSchema.optional(),
})
export type SyncInstallationRequest = z.infer<typeof syncInstallationRequestSchema>

export const syncInstallationResponseSchema = z.object({ queued: z.number().int() })
export type SyncInstallationResponse = z.infer<typeof syncInstallationResponseSchema>

/** A directory person, as an admin sees the synced list. */
export const directoryUserSchema = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  accountEnabled: z.boolean(),
  matchedUserId: z.string().uuid().nullable(),
  deletedAt: z.coerce.date().nullable(),
})
export type DirectoryUser = z.infer<typeof directoryUserSchema>

export const directoryUserListQuerySchema = paginationQuerySchema.extend({
  installationId: z.string().uuid(),
})
export const directoryUserListResponseSchema = paginatedResponse(directoryUserSchema)
export type DirectoryUserListResponse = z.infer<typeof directoryUserListResponseSchema>

export const calendarAttendeeSchema = z.object({
  email: z.string().nullable(),
  name: z.string().nullable(),
  response: z.string().nullable(),
})

/** One synced calendar event. Visible to the mailbox's owner and to admins, nobody else. */
export const calendarEventSchema = z.object({
  id: z.string().uuid(),
  provider: connectorProviderIdSchema,
  ownerUserId: z.string().uuid().nullable(),
  title: z.string(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  isAllDay: z.boolean(),
  location: z.string().nullable(),
  organizerEmail: z.string().nullable(),
  organizerName: z.string().nullable(),
  attendees: z.array(calendarAttendeeSchema),
  webLink: z.string().nullable(),
  isCancelled: z.boolean(),
})
export type CalendarEvent = z.infer<typeof calendarEventSchema>

/** The most a window may span, and the most one answer carries. */
export const CALENDAR_WINDOW_MAX_DAYS = 62
export const CALENDAR_EVENTS_MAX = 500

/**
 * `GET /api/connectors/events?from=&to=` — the caller's own events by default. `scope=all` is for
 * `manage Connector` (every synced mailbox in the organisation); `userId` narrows it to one person.
 */
export const calendarEventListQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    scope: z.enum(['mine', 'all']).default('mine'),
    userId: z.string().uuid().optional(),
  })
  .refine(q => q.to > q.from, { message: '`to` must be after `from`', path: ['to'] })
  .refine(q => q.to.getTime() - q.from.getTime() <= CALENDAR_WINDOW_MAX_DAYS * 86_400_000, {
    message: `The window may span at most ${CALENDAR_WINDOW_MAX_DAYS} days`,
    path: ['to'],
  })
export type CalendarEventListQuery = z.infer<typeof calendarEventListQuerySchema>

export const calendarEventListResponseSchema = z.object({
  items: z.array(calendarEventSchema),
  /** True when the window held more than `CALENDAR_EVENTS_MAX` — narrow it. */
  truncated: z.boolean(),
})
export type CalendarEventListResponse = z.infer<typeof calendarEventListResponseSchema>

/** The job's payload. Ids only — the handler re-reads everything, including the installation. */
export const connectorsSyncPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  cursorId: z.string().uuid(),
})
export type ConnectorsSyncPayload = z.infer<typeof connectorsSyncPayloadSchema>

// ---- The plugin ---------------------------------------------------------------------------------

export const connectorsShared = {
  id: CONNECTORS_ID,
  label: 'Connectors',
  version: '3.1.0',
  subjects: [CONNECTOR_SUBJECT],
  jobs: [z.object({ type: z.literal(CONNECTORS_SYNC_JOB), payload: connectorsSyncPayloadSchema })],
  features: {
    [CONNECTORS_FLAG]: {
      label: 'Connectors',
      description:
        'Organisation connections to Microsoft 365 / Google Workspace: directory and calendar ' +
        'sync. Off stops the sync cron for the tenant and hides the Connections surfaces.',
      defaultState: 'on',
      defaultRolloutUnit: 'tenant',
      environmentGated: false,
    } satisfies FeatureDefinition,
  },
} as const satisfies SharedPlugin
