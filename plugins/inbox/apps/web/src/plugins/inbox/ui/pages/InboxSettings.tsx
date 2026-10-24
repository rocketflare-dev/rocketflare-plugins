/**
 * Settings → Inbox: the address this organisation receives on, who may send to it, and whether
 * mail must authenticate. Read-only without `manage InboxSettings`.
 *
 * The domain half of the address is whatever Cloudflare Email Routing routes to this Worker, which
 * the app cannot know — the page shows this site's host as the likely one and says so.
 */
import {
  INBOX_LOCAL_PART_RE,
  INBOX_SENDER_RE,
  type InboxSettings as Settings,
} from '@rocketflare/shared/plugins/inbox/index'
import { useState } from 'react'
import {
  ApiError,
  SectionPanel,
  SectionPanelSkeleton,
  SettingInput,
  SettingRow,
  SettingToggle,
  showToast,
  usePermissions,
} from '@/plugins/api/ui'
import { useInboxSettings, useUpdateInboxSettings } from '../hooks/useInbox'

export default function InboxSettingsPage() {
  const settings = useInboxSettings()
  if (settings.isPending) return <SectionPanelSkeleton rows={4} />
  if (settings.isError || !settings.data) {
    return (
      <SectionPanel title="Inbox">
        <p className="text-sm text-error">The inbox settings could not be loaded.</p>
      </SectionPanel>
    )
  }
  return <SettingsForm key={String(settings.data.updatedAt)} settings={settings.data} />
}

function parseSenders(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

function SettingsForm({ settings }: { settings: Settings }) {
  const { can } = usePermissions()
  const canManage = can('manage', 'InboxSettings')
  const update = useUpdateInboxSettings()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [localPart, setLocalPart] = useState(settings.localPart ?? '')
  const [senders, setSenders] = useState(settings.allowedSenders.join('\n'))
  const [requireAuth, setRequireAuth] = useState(settings.requireAuthentication)

  const parsedSenders = parseSenders(senders)
  const badSender = parsedSenders.find(s => !INBOX_SENDER_RE.test(s))
  const localPartError =
    localPart && !INBOX_LOCAL_PART_RE.test(localPart)
      ? 'Lower-case letters, digits, dots, dashes or underscores'
      : undefined
  const host = typeof window === 'undefined' ? 'your-domain' : window.location.hostname

  const save = () =>
    update.mutate(
      {
        enabled,
        ...(localPart && { localPart }),
        allowedSenders: parsedSenders,
        requireAuthentication: requireAuth,
      },
      {
        onSuccess: () => showToast('Inbox settings saved', 'success'),
        onError: err =>
          showToast(err instanceof ApiError ? err.message : 'Could not save the settings', 'error'),
      }
    )

  return (
    <SectionPanel
      title="Inbox"
      description="Receive forwarded email (receipts, invoices, notices) through Cloudflare Email Routing."
    >
      <SettingInput
        id="inbox-local-part"
        label="Address"
        description={
          localPart
            ? `Mail to ${localPart}@${host} (and ${localPart}+anything@${host}) arrives here, once Email Routing sends that address to this app.`
            : 'The part before the @. Email Routing must send this address to this app.'
        }
        value={localPart}
        onChange={v => setLocalPart(v.trim().toLowerCase())}
        placeholder="receipts"
        disabled={!canManage}
        error={localPartError}
      />
      <SettingRow
        label="Allowed senders"
        description="One per line: an address (me@gmail.com) or a whole domain (@example.com). A forwarded message is accepted when the forwarding mailbox or the original sender is listed. Forwarding confirmations from Gmail and Proton are always let through so you can see the code."
        htmlFor="inbox-senders"
      >
        <div className="w-full sm:w-72">
          <textarea
            id="inbox-senders"
            className={`textarea textarea-sm w-full ${badSender ? 'textarea-error' : ''}`}
            rows={4}
            value={senders}
            onChange={e => setSenders(e.target.value)}
            disabled={!canManage}
          />
          {badSender && (
            <p className="mt-1 text-xs text-error">Not an address or domain: {badSender}</p>
          )}
        </div>
      </SettingRow>
      <SettingToggle
        id="inbox-require-auth"
        label="Require authentication"
        description="Refuse mail unless SPF, DKIM or DMARC passed. Leave on: it is what stops anyone forging an allowed sender."
        checked={requireAuth}
        onChange={setRequireAuth}
        disabled={!canManage}
      />
      <SettingToggle
        id="inbox-enabled"
        label="Accept mail"
        description="Off: everything except forwarding confirmations is bounced."
        checked={enabled}
        onChange={setEnabled}
        disabled={!canManage || !localPart}
      />
      {canManage && (
        <div className="flex justify-end pt-4">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={update.isPending || Boolean(badSender) || Boolean(localPartError)}
            onClick={save}
          >
            Save
          </button>
        </div>
      )}
    </SectionPanel>
  )
}
