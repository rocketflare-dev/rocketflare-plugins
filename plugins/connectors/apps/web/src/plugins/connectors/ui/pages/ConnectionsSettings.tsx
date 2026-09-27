/**
 * Settings → Connections: connect the organisation's Microsoft 365 / Google Workspace, watch the
 * sync, disconnect.
 *
 * One card per provider an installed plugin contributes. "Connect" asks the server for a consent
 * URL and sends the browser there; the provider brings the admin back to this tab with
 * `?connected=` or `?connectError=`, which is read once and turned into a toast. Credentials for a
 * bring-your-own app are typed here and never come back — the card says "Own app" from
 * `hasCredential`.
 *
 * **Each audience sees only what it can act on.** A reader without `manage Connector` sees status
 * and nothing to press. An organisation admin sees the consent they give and the permissions it
 * grants — or, when this deployment has not registered its app, that it is the OPERATOR's job,
 * plus the bring-your-own route where the provider supports one. Only a platform operator (a global
 * admin, `viewer.isOperator`) is sent the deployment's own setup steps; the server leaves them out
 * for everyone else, so this page cannot show them by mistake.
 */
import type {
  ConnectorInstallation,
  ConnectorProviderInfo,
  ConnectorProviderListResponse,
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
          viewer={providers.data.viewer}
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
  viewer,
}: {
  provider: ConnectorProviderInfo
  installation: ConnectorInstallation | undefined
  viewer: ConnectorProviderListResponse['viewer']
}) {
  const { can } = usePermissions()
  const canManage = can('manage', 'Connector')
  const start = useStartInstallation()
  const sync = useSyncInstallation()
  const remove = useDeleteInstallation()
  // With no deployment app to fall back on, the organisation's own app is the only way in.
  const [byo, setByo] = useState(
    installation?.appMode === 'byo' || (provider.supportsByo && !provider.operatorConfigured)
  )
  const [regrant, setRegrant] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const goToConsent = {
    onSuccess: ({ consentUrl }: { consentUrl: string }) => window.location.assign(consentUrl),
  }
  const connect = () =>
    start.mutate(
      byo
        ? { provider: provider.id, appMode: 'byo', clientId, clientSecret }
        : { provider: provider.id, appMode: 'operator' },
      goToConsent
    )

  const status = installation?.status
  const connected = installation !== undefined && status !== 'pending'
  // The form: before a connection exists, and again when a bring-your-own app re-grants — the
  // server never hands its secret back, so re-granting means typing it again.
  const showForm = canManage && (!connected || regrant)
  const connectDisabled =
    start.isPending ||
    (byo ? !clientId.trim() || !clientSecret.trim() : !provider.operatorConfigured)

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
      {connected && <InstallationDetails installation={installation} />}
      {!connected && !canManage && (
        <p className="text-sm text-base-content/70">
          Not connected yet. An owner or admin of this organisation connects {provider.label} from
          this tab.
        </p>
      )}

      {showForm && (
        <div className="space-y-3">
          {!provider.operatorConfigured && (
            <NotConfiguredNotice provider={provider} isOperator={viewer.isOperator} />
          )}
          {!byo && provider.operatorConfigured && <SetupSteps provider={provider} />}
          {provider.supportsByo && provider.operatorConfigured && (
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
            <>
              <ByoSteps provider={provider} />
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  className="input input-bordered input-sm"
                  placeholder="Application (client) ID"
                  aria-label="Client id"
                  value={clientId}
                  onChange={e => setClientId(e.target.value)}
                />
                <input
                  className="input input-bordered input-sm"
                  type="password"
                  placeholder="Client secret (the value, not its ID)"
                  aria-label="Client secret"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                />
              </div>
            </>
          )}
          {(byo || provider.operatorConfigured) && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={connectDisabled}
              onClick={connect}
            >
              {status === 'pending' || regrant ? 'Retry consent' : `Connect ${provider.label}`}
            </button>
          )}
        </div>
      )}

      {canManage && connected && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm"
            disabled={sync.isPending}
            onClick={() =>
              sync.mutate(
                { id: installation.id },
                { onSuccess: ({ queued }) => showToast(`Queued ${queued} sync job(s).`, 'info') }
              )
            }
          >
            Sync now
          </button>
          {!regrant && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={start.isPending}
              // The deployment's app re-grants in one click; an organisation's own app needs its
              // credentials again, so it reopens the form instead.
              onClick={() =>
                installation.appMode === 'byo'
                  ? setRegrant(true)
                  : start.mutate({ provider: provider.id, appMode: 'operator' }, goToConsent)
              }
            >
              Re-grant consent
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-error btn-outline"
            onClick={() => setConfirmRemove(true)}
          >
            Disconnect
          </button>
        </div>
      )}

      {viewer.isOperator && provider.operatorSteps.length > 0 && (
        <OperatorSetup provider={provider} />
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

/** No deployment app: say whose job that is, in words the reader can act on. */
function NotConfiguredNotice({
  provider,
  isOperator,
}: {
  provider: ConnectorProviderInfo
  isOperator: boolean
}) {
  return (
    <div role="status" className="alert alert-warning text-sm">
      {isOperator ? (
        <span>
          {provider.label} isn't set up on this deployment yet. Register the deployment's app with
          the steps under <strong>Deployment setup</strong> below — or ask your coding agent to run
          the <code>connectors</code> skill, which walks through it.
        </span>
      ) : (
        <span>
          {provider.label} isn't set up on this deployment yet — ask your platform operator to
          register its app.
          {provider.supportsByo && " Or connect your organisation's own app below."}
        </span>
      )}
    </div>
  )
}

/**
 * Registering the organisation's OWN app. Provider-neutral on purpose — the values that differ
 * (the redirect URI, the permissions) come from the server — and accurate for the one shape every
 * provider's consent flow needs: an app other directories can consent to, with a secret.
 */
function ByoSteps({ provider }: { provider: ConnectorProviderInfo }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">Connect your organisation's own app</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          In your {provider.label} admin console, register a new application that accepts admin
          consent from any organisation (a multi-tenant app).
        </li>
        <li>
          Add this redirect URI, of type <strong>Web</strong>: <code>{provider.redirectUri}</code>
        </li>
        <li>
          Add these <strong>application</strong> permissions (not delegated):{' '}
          {provider.permissions.map((p, i) => (
            <span key={p.scope}>
              {i > 0 && ', '}
              <code>{p.scope}</code>
            </span>
          ))}
          .
        </li>
        <li>
          Create a client secret and note when it expires. Rotating it later means connecting again
          here with the new one.
        </li>
        <li>
          Paste the application (client) ID and the secret's value below and press{' '}
          <strong>Connect</strong>. An administrator of your organisation then grants consent.
        </li>
      </ol>
      {provider.docsUrl && (
        <a className="link" href={provider.docsUrl} target="_blank" rel="noreferrer">
          Provider documentation
        </a>
      )}
    </div>
  )
}

/**
 * The deployment's own app — for the platform operator only (the server sends these steps to a
 * global admin and to nobody else). Open while the app is missing; folded away once it works.
 */
function OperatorSetup({ provider }: { provider: ConnectorProviderInfo }) {
  return (
    <details
      className="mt-4 rounded-box border border-base-300 p-3 text-sm"
      open={!provider.operatorConfigured}
    >
      <summary className="cursor-pointer font-medium">
        Deployment setup (platform operator) —{' '}
        {provider.operatorConfigured ? 'configured' : 'not configured'}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-base-content/70">
          Only platform operators see this. Ask your coding agent to run the <code>connectors</code>{' '}
          skill to do these steps for you, or follow them by hand.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          {provider.operatorSteps.map(step => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p>
          This deployment's redirect URI: <code>{provider.redirectUri}</code>
        </p>
      </div>
    </details>
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
