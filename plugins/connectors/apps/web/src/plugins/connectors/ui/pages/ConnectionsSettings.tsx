/**
 * Settings → Connections: connect the organisation's Microsoft 365 / Google Workspace, watch the
 * sync, disconnect.
 *
 * One card per provider an installed plugin contributes. "Connect" asks the server for a consent
 * URL and sends the browser there; the provider brings the admin back to this tab with
 * `?connected=` or `?connectError=`, which is read once and turned into a toast. Credentials for a
 * bring-your-own app are typed here and never come back — the card says "Own app" from
 * `hasCredential`. Read-only without `manage Connector`.
 */
import type {
  ConnectorInstallation,
  ConnectorProviderInfo,
} from '@rocketflare/shared/plugins/connectors/index'
import { useEffect, useState } from 'react'
import {
  ConfirmModal,
  SectionPanel,
  SectionPanelSkeleton,
  showToast,
  timeAgo,
  usePermissions,
} from '@/plugins/api/ui'
import {
  useConnectorInstallations,
  useConnectorProviders,
  useDeleteInstallation,
  useStartInstallation,
  useSyncInstallation,
} from '../hooks/useConnectors'

/** What the callback's error codes mean to the admin who just clicked through consent. */
const CONNECT_ERRORS: Record<string, string> = {
  invalid_state: 'The connection link expired or was not ours. Start again from this page.',
  consent_not_granted: 'Consent was not granted, so nothing was connected.',
  admin_consent_required: 'An administrator of that organisation has to grant consent.',
  external_tenant_mismatch:
    'This organisation is already connected to a different directory. Disconnect it first.',
  feature_disabled: 'Connections are turned off for this organisation.',
}

export default function ConnectionsSettingsPage() {
  const providers = useConnectorProviders()
  const installations = useConnectorInstallations()
  useCallbackToast()

  if (providers.isPending || installations.isPending) return <SectionPanelSkeleton rows={4} />
  if (providers.isError || installations.isError) {
    return (
      <SectionPanel title="Connections">
        <p className="text-sm text-error">The connections could not be loaded.</p>
      </SectionPanel>
    )
  }
  if (providers.data.items.length === 0) {
    return (
      <SectionPanel title="Connections">
        <p className="text-sm text-base-content/70">
          No provider is installed. Install the <code>m365</code> plugin (or another connector
          provider) to connect an organisation's directory and calendars.
        </p>
      </SectionPanel>
    )
  }
  return (
    <div className="space-y-6">
      {providers.data.items.map(provider => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          installation={installations.data.items.find(i => i.provider === provider.id)}
        />
      ))}
    </div>
  )
}

/** The provider's redirect lands here with the outcome in the query; say it once, then drop it. */
function useCallbackToast() {
  useEffect(() => {
    const url = new URL(window.location.href)
    const connected = url.searchParams.get('connected')
    const error = url.searchParams.get('connectError')
    if (!connected && !error) return
    if (connected) showToast('Connected. The first sync has started.', 'success')
    if (error) showToast(CONNECT_ERRORS[error] ?? `Connecting failed (${error}).`, 'error')
    url.searchParams.delete('connected')
    url.searchParams.delete('connectError')
    window.history.replaceState(null, '', url.toString())
  }, [])
}

function ProviderCard({
  provider,
  installation,
}: {
  provider: ConnectorProviderInfo
  installation: ConnectorInstallation | undefined
}) {
  const { can } = usePermissions()
  const canManage = can('manage', 'Connector')
  const start = useStartInstallation()
  const sync = useSyncInstallation()
  const remove = useDeleteInstallation()
  const [byo, setByo] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const connect = () =>
    start.mutate(
      byo
        ? { provider: provider.id, appMode: 'byo', clientId, clientSecret }
        : { provider: provider.id, appMode: 'operator' },
      { onSuccess: ({ consentUrl }) => window.location.assign(consentUrl) }
    )

  const status = installation?.status
  return (
    <SectionPanel
      title={provider.label}
      description={provider.description}
      actions={
        status ? (
          <span
            className={`badge ${status === 'active' ? 'badge-success' : status === 'error' ? 'badge-error' : 'badge-ghost'}`}
          >
            {status === 'pending' ? 'Waiting for consent' : status}
          </span>
        ) : null
      }
    >
      {installation && status !== 'pending' ? (
        <InstallationDetails installation={installation} />
      ) : (
        <SetupSteps provider={provider} />
      )}

      {canManage && (
        <div className="mt-4 space-y-3">
          {(!installation || status === 'pending') && (
            <>
              {provider.supportsByo && (
                <label className="label cursor-pointer justify-start gap-2">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={byo}
                    onChange={e => setByo(e.target.checked)}
                  />
                  <span className="label-text">Use our organisation's own registered app</span>
                </label>
              )}
              {byo && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    className="input input-bordered input-sm"
                    placeholder="Client (application) id"
                    aria-label="Client id"
                    value={clientId}
                    onChange={e => setClientId(e.target.value)}
                  />
                  <input
                    className="input input-bordered input-sm"
                    type="password"
                    placeholder="Client secret"
                    aria-label="Client secret"
                    autoComplete="off"
                    value={clientSecret}
                    onChange={e => setClientSecret(e.target.value)}
                  />
                </div>
              )}
              {!byo && !provider.operatorConfigured && (
                <p className="text-sm text-warning">
                  This deployment has not registered its {provider.label} app yet. Ask the operator,
                  or connect your own app.
                </p>
              )}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={
                  start.isPending ||
                  (byo ? !clientId.trim() || !clientSecret.trim() : !provider.operatorConfigured)
                }
                onClick={connect}
              >
                {status === 'pending' ? 'Retry consent' : `Connect ${provider.label}`}
              </button>
            </>
          )}
          {installation && status !== 'pending' && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-sm"
                disabled={sync.isPending}
                onClick={() =>
                  sync.mutate(
                    { id: installation.id },
                    {
                      onSuccess: ({ queued }) => showToast(`Queued ${queued} sync job(s).`, 'info'),
                    }
                  )
                }
              >
                Sync now
              </button>
              <button type="button" className="btn btn-sm" onClick={connect}>
                Re-grant consent
              </button>
              <button
                type="button"
                className="btn btn-sm btn-error btn-outline"
                onClick={() => setConfirmRemove(true)}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmRemove}
        title={`Disconnect ${provider.label}?`}
        message={`Every synced user, group and calendar event from ${provider.label} is deleted from this app. To revoke the app's access on the provider's side as well, remove it from your organisation's admin console.`}
        confirmText="Disconnect"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() =>
          installation &&
          remove.mutate(installation.id, {
            onSuccess: () => {
              setConfirmRemove(false)
              showToast(`${provider.label} disconnected.`, 'success')
            },
          })
        }
      />
    </SectionPanel>
  )
}

function SetupSteps({ provider }: { provider: ConnectorProviderInfo }) {
  return (
    <div className="space-y-3 text-sm">
      <ol className="list-decimal space-y-1 pl-5">
        {provider.adminSteps.map(step => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <details>
        <summary className="cursor-pointer text-base-content/70">
          Permissions requested ({provider.permissions.length})
        </summary>
        <ul className="mt-2 space-y-1 pl-5">
          {provider.permissions.map(p => (
            <li key={p.scope}>
              <code>{p.scope}</code> — {p.reason}
            </li>
          ))}
        </ul>
      </details>
      {provider.docsUrl && (
        <a className="link" href={provider.docsUrl} target="_blank" rel="noreferrer">
          Setup guide
        </a>
      )}
    </div>
  )
}

function InstallationDetails({ installation }: { installation: ConnectorInstallation }) {
  const { counts } = installation
  return (
    <div className="space-y-3 text-sm">
      <p>
        Connected to <strong>{installation.displayName ?? installation.externalTenantId}</strong>
        {installation.appMode === 'byo' && ' with your own app'}
        {installation.installedAt && <> · since {timeAgo(installation.installedAt)}</>}
      </p>
      {installation.lastError && <p className="text-error">{installation.lastError}</p>}
      <p className="text-base-content/70">
        {counts.users} people ({counts.matchedUsers} members of this app) · {counts.groups} groups ·{' '}
        {counts.mailboxes} calendars · {counts.events} events
      </p>
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Cursors</th>
            <th>Last synced</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {installation.cursors.map(c => (
            <tr key={c.resource}>
              <td>{c.resource}</td>
              <td>{c.count}</td>
              <td>{timeAgo(c.lastSyncedAt)}</td>
              <td>
                {c.failing > 0 ? (
                  <span className="text-error" title={c.lastError ?? undefined}>
                    {c.failing} failing
                  </span>
                ) : c.backfilling > 0 ? (
                  `${c.backfilling} backfilling`
                ) : (
                  'up to date'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {installation.grantedScopes.length > 0 && (
        <p className="text-xs text-base-content/60">
          Granted: {installation.grantedScopes.join(', ')}
        </p>
      )}
    </div>
  )
}
