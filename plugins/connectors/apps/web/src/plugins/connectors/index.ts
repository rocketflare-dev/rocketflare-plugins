/**
 * `connectors` — SERVER entry (D34).
 *
 * Read top to bottom: one authenticated mount (settings, status, the synced data) behind the
 * `connectors` flag, one PUBLIC mount (the providers' consent callback, later their webhooks), one
 * job, one quarter-hour cron, one CASL subject. No provider lives here — `m365` and, later,
 * `google-workspace` contribute theirs through `extensions`, which is why this file also publishes
 * `connectorExtensions` and the provider contract: they are part of this plugin's four-entry API,
 * and its semver covers them.
 *
 * The adapters (`jobCtx`, `cronCtx`, `requestCtx`, `publicCtx`) are called once each, at the
 * registration boundaries, and nowhere else.
 */
import {
  CONNECTOR_SUBJECT,
  CONNECTORS_FLAG,
  CONNECTORS_SYNC_JOB,
  connectorsShared,
} from '@rocketflare/shared/plugins/connectors/index'
import type { ServerPlugin } from '@/plugins/api'
import { requireFeature } from '@/plugins/api'
import { connectorsHooksRouter } from './api/hooks'
import { connectorsRouter } from './api/routes'
import { CONNECTORS_CRON, enqueueDueSyncsTask } from './api/scheduled'
import { handleConnectorsSync } from './jobs/sync'

export const connectorsServer = {
  shared: connectorsShared,
  mounts: [['/api/connectors', connectorsRouter, requireFeature(CONNECTORS_FLAG)]],
  /** `/api/hooks/<id>` is the only prefix a public mount may take — the kit's config test says so. */
  publicMounts: [['/api/hooks/connectors', connectorsHooksRouter]],
  jobHandlers: { [CONNECTORS_SYNC_JOB]: handleConnectorsSync },
  scheduledTasks: { [CONNECTORS_CRON]: [enqueueDueSyncsTask] },
  /**
   * Additive, over this plugin's own subject. Owners and admins connect and see everything synced;
   * `support` may see that a connection exists and how it is doing, never anybody's calendar;
   * members have no grant at all — they read their OWN events, which needs no subject.
   */
  grants: {
    owner: can => can('manage', CONNECTOR_SUBJECT),
    admin: can => can('manage', CONNECTOR_SUBJECT),
    support: can => can('read', CONNECTOR_SUBJECT),
  },
} satisfies ServerPlugin<typeof connectorsShared>

/**
 * What a PROVIDER plugin imports (D31 decision 6): the contract it implements, the errors it throws
 * to steer the engine, and the helper that builds its `extensions` record.
 */
export {
  type CalendarEventItem,
  type CalendarSource,
  type CalendarWindow,
  CONNECTOR_EXTENSION_KEYS,
  ConnectorAuthError,
  type ConnectorCredentials,
  type ConnectorProvider,
  ConsentError,
  type ConsentResult,
  CursorExpiredError,
  connectorExtensions,
  type DirectoryGroupItem,
  type DirectorySource,
  type DirectoryUserItem,
  type FetchLike,
  type InstallationView,
  type MintedToken,
  RetryLaterError,
  type SourceCtx,
  type SubjectView,
  type SyncPage,
} from './providers'
