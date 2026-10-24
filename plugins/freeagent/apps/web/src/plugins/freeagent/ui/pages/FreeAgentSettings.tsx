/**
 * Settings → FreeAgent: connect, reconnect or disconnect this organisation's FreeAgent company,
 * see which environment the deployment uses, when the books last synced and what went wrong, and
 * sync now. Read-only without `manage FreeAgent`.
 *
 * Connecting leaves the app: the API answers FreeAgent's approve URL and the browser goes there;
 * FreeAgent sends it back to `/api/hooks/freeagent/callback`, which lands here with `?connected=`
 * or `?connectError=` — read once, turned into a toast, and dropped from the address bar.
 */
import type { FreeAgentStatus } from '@rocketflare/shared/plugins/freeagent/index'
import { useEffect, useState } from 'react'
import {
  ApiError,
  ConfirmModal,
  formatDateTime,
  SectionPanel,
  SectionPanelSkeleton,
  SettingRow,
  showToast,
  timeAgo,
  usePermissions,
} from '@/plugins/api/ui'
import {
  useConnectFreeAgent,
  useDisconnectFreeAgent,
  useFreeAgentStatus,
  useSyncFreeAgent,
} from '../hooks/useFreeAgent'

const CONNECT_ERRORS: Record<string, string> = {
  access_denied: 'FreeAgent access was not granted.',
  approval_failed: 'FreeAgent did not approve the connection.',
  missing_code: 'FreeAgent sent no approval code. Try again.',
  not_configured: 'This deployment has no FreeAgent app configured.',
  code_expired: 'The approval expired before it was used. Try again.',
  exchange_failed: 'Completing the connection with FreeAgent failed. Try again.',
}

function useCallbackToast() {
  useEffect(() => {
    const url = new URL(window.location.href)
    const connected = url.searchParams.get('connected')
    const error = url.searchParams.get('connectError')
    if (connected !== 'freeagent' && !error) return
    if (connected === 'freeagent')
      showToast('FreeAgent connected. The first sync has started.', 'success')
    if (error) showToast(CONNECT_ERRORS[error] ?? `Connecting failed (${error}).`, 'error')
    url.searchParams.delete('connected')
    url.searchParams.delete('connectError')
    window.history.replaceState(null, '', url.toString())
  }, [])
}

export default function FreeAgentSettingsPage() {
  useCallbackToast()
  const status = useFreeAgentStatus()
  if (status.isPending) return <SectionPanelSkeleton rows={4} />
  if (status.isError || !status.data) {
    return (
      <SectionPanel title="FreeAgent">
        <p className="text-sm text-error">The FreeAgent status could not be loaded.</p>
      </SectionPanel>
    )
  }
  return <Connection status={status.data} />
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

function Connection({ status }: { status: FreeAgentStatus }) {
  const { can } = usePermissions()
  const canManage = can('manage', 'FreeAgent')
  const connect = useConnectFreeAgent()
  const disconnect = useDisconnectFreeAgent()
  const sync = useSyncFreeAgent()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const hasConnection = status.status !== null
  const mismatch =
    status.connectionEnvironment !== null && status.connectionEnvironment !== status.environment

  const startConnect = () =>
    connect.mutate(undefined, {
      onSuccess: ({ approveUrl }) => window.location.assign(approveUrl),
      onError: err => showToast(errorMessage(err, 'Could not start connecting'), 'error'),
    })

  return (
    <SectionPanel
      title="FreeAgent"
      description="Connect this organisation's FreeAgent company. Its bank transactions, explanations, categories, contacts, bills and invoices are mirrored here every 30 minutes."
    >
      <SettingRow label="Environment" description="Set by the deployment (FREEAGENT_ENVIRONMENT).">
        <span
          className={`badge ${status.environment === 'production' ? 'badge-primary' : 'badge-warning'}`}
        >
          {status.environment}
        </span>
      </SettingRow>
      {!status.configured && (
        <div role="alert" className="alert alert-warning my-2 text-sm">
          This deployment has no FreeAgent app. An operator sets FREEAGENT_CLIENT_ID and
          FREEAGENT_CLIENT_SECRET (see the freeagent skill).
        </div>
      )}
      <SettingRow label="Connection">
        {status.connected ? (
          <span className="badge badge-success">connected</span>
        ) : status.status === 'needs_reconnect' ? (
          <span className="badge badge-error">needs reconnecting</span>
        ) : (
          <span className="badge badge-ghost">not connected</span>
        )}
      </SettingRow>
      {hasConnection && (
        <>
          <SettingRow label="Company">
            <span className="text-sm">
              {status.companyName ?? '—'}
              {status.companyCurrency ? ` (${status.companyCurrency})` : ''}
            </span>
          </SettingRow>
          <SettingRow label="Last sync">
            <span className="text-sm" title={formatDateTime(status.lastSyncAt)}>
              {timeAgo(status.lastSyncAt)}
              {status.lastSyncAt &&
                ` · ${status.counts.transactions} transactions, ${status.counts.unexplained} unexplained`}
            </span>
          </SettingRow>
        </>
      )}
      {mismatch && (
        <div role="alert" className="alert alert-warning my-2 text-sm">
          This connection was made in {status.connectionEnvironment}; the deployment now uses{' '}
          {status.environment}. Reconnect to switch.
        </div>
      )}
      {status.lastError && (
        <div role="alert" className="alert alert-error my-2 text-sm">
          <span>
            {status.lastError}
            {status.lastErrorAt && ` (${timeAgo(status.lastErrorAt)})`}
          </span>
        </div>
      )}
      {canManage && (
        <div className="flex flex-wrap justify-end gap-2 pt-4">
          {status.connected && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={sync.isPending}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: () => showToast('Sync queued', 'success'),
                  onError: err => showToast(errorMessage(err, 'Could not queue a sync'), 'error'),
                })
              }
            >
              Sync now
            </button>
          )}
          {hasConnection && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-error"
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!status.configured || connect.isPending}
            onClick={startConnect}
          >
            {hasConnection ? 'Reconnect' : 'Connect FreeAgent'}
          </button>
        </div>
      )}
      <ConfirmModal
        isOpen={confirmDisconnect}
        title="Disconnect FreeAgent?"
        message="The stored tokens are deleted, and so is the mirrored copy of the books here. Nothing in FreeAgent itself changes."
        confirmText="Disconnect"
        confirmButtonClass="btn-error"
        isLoading={disconnect.isPending}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => {
              setConfirmDisconnect(false)
              showToast('FreeAgent disconnected', 'success')
            },
            onError: err => showToast(errorMessage(err, 'Could not disconnect'), 'error'),
          })
        }
      />
    </SectionPanel>
  )
}
