/**
 * Settings → Web search: pick a provider, paste the organisation's key, test it, turn it on.
 *
 * The key never comes back from the server — the page shows "Key saved" from `hasCredential`, and
 * an empty key field on save means "keep the one you have". Changing provider without typing a new
 * key clears the old one server-side, so the page says so before it happens. Read-only for anyone
 * without `manage WebSearchConfig`.
 */
import {
  type WebSearchSettings as Settings,
  type TestWebSearchResponse,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_PROVIDER_INFO,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from '@rocketflare/shared/plugins/web-knowledge/index'
import { useState } from 'react'
import {
  ApiError,
  SectionPanel,
  SectionPanelSkeleton,
  SettingRow,
  SettingToggle,
  showToast,
  usePermissions,
} from '@/plugins/api/ui'
import {
  useTestWebSearch,
  useUpdateWebSearchSettings,
  useWebSearchSettings,
} from '../hooks/useWebSearchSettings'

export default function WebSearchSettingsPage() {
  const settings = useWebSearchSettings()
  if (settings.isPending) return <SectionPanelSkeleton rows={4} />
  if (settings.isError || !settings.data) {
    return (
      <SectionPanel title="Web search">
        <p className="text-sm text-error">The web search settings could not be loaded.</p>
      </SectionPanel>
    )
  }
  // Keyed on `updatedAt` so a save (or a colleague's, via the nudge) resets the form to the server.
  return <SettingsForm key={String(settings.data.updatedAt)} settings={settings.data} />
}

function SettingsForm({ settings }: { settings: Settings }) {
  const { can } = usePermissions()
  const canManage = can('manage', 'WebSearchConfig')
  const update = useUpdateWebSearchSettings()
  const test = useTestWebSearch()
  const [provider, setProvider] = useState<WebSearchProvider>(settings.provider)
  const [apiKey, setApiKey] = useState('')
  const [maxResults, setMaxResults] = useState(settings.maxResults)
  const [verdict, setVerdict] = useState<TestWebSearchResponse | null>(null)

  const info = WEB_SEARCH_PROVIDER_INFO[provider]
  const providerChanged = provider !== settings.provider
  const keyAvailable = apiKey.trim().length > 0 || (settings.hasCredential && !providerChanged)
  const dirty = providerChanged || apiKey.trim().length > 0 || maxResults !== settings.maxResults

  async function save(body: Parameters<typeof update.mutateAsync>[0], done: string) {
    try {
      await update.mutateAsync(body)
      showToast(done, 'success')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not save', 'error')
    }
  }

  function saveForm() {
    return save(
      {
        provider,
        maxResults,
        ...(apiKey.trim() && { apiKey: apiKey.trim() }),
        // Switching provider without a key would leave search on with nothing to search with.
        ...(!keyAvailable && { enabled: false }),
      },
      // The server turns search on with the first key, so say so rather than leave it a surprise.
      !settings.hasCredential && apiKey.trim()
        ? 'Key saved — web search is on for agents and chat'
        : 'Web search settings saved'
    )
  }

  async function runTest() {
    setVerdict(null)
    try {
      setVerdict(
        await test.mutateAsync({ provider, ...(apiKey.trim() && { apiKey: apiKey.trim() }) })
      )
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'The test could not run', 'error')
    }
  }

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Web search"
        description="Let agents and chat search the public web and read pages, using your organisation's own search API key."
      >
        <SettingToggle
          id="web-search-enabled"
          label="Web search for agents and chat"
          description={
            settings.hasCredential
              ? 'When on, every agent run and chat turn in this organisation can call web_search and fetch_page.'
              : 'Saving an API key below turns this on.'
          }
          checked={settings.enabled}
          disabled={
            !canManage || update.isPending || (!settings.enabled && !settings.hasCredential)
          }
          onChange={enabled =>
            save({ enabled }, enabled ? 'Web search turned on' : 'Web search turned off')
          }
        />
      </SectionPanel>

      <SectionPanel title="Provider" description={info.description}>
        <SettingRow
          label="Search provider"
          htmlFor="web-search-provider"
          description={
            <a className="link" href={info.keyUrl} target="_blank" rel="noreferrer">
              Get a {info.name} API key
            </a>
          }
        >
          <select
            id="web-search-provider"
            className="select select-sm w-full sm:w-72"
            value={provider}
            disabled={!canManage}
            onChange={e => {
              setProvider(e.target.value as WebSearchProvider)
              setVerdict(null)
            }}
          >
            {WEB_SEARCH_PROVIDERS.map(id => (
              <option key={id} value={id}>
                {WEB_SEARCH_PROVIDER_INFO[id].name}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label="API key"
          htmlFor="web-search-key"
          description={
            providerChanged && settings.hasCredential && !apiKey.trim()
              ? `Saving clears the ${WEB_SEARCH_PROVIDER_INFO[settings.provider].name} key — keys are per provider.`
              : settings.hasCredential && !providerChanged
                ? 'Key saved. Leave blank to keep it.'
                : 'Stored encrypted. It is never shown again after saving.'
          }
        >
          <input
            id="web-search-key"
            type="password"
            autoComplete="off"
            className="input input-sm w-full sm:w-72"
            placeholder={settings.hasCredential && !providerChanged ? '••••••••' : 'Paste key'}
            value={apiKey}
            disabled={!canManage}
            onChange={e => {
              setApiKey(e.target.value)
              setVerdict(null)
            }}
          />
        </SettingRow>
        <SettingRow
          label="Results per search"
          htmlFor="web-search-max"
          description={`The most one search may return (1–${WEB_SEARCH_MAX_RESULTS}). Fewer is cheaper and keeps replies focused.`}
        >
          <input
            id="web-search-max"
            type="number"
            min={1}
            max={WEB_SEARCH_MAX_RESULTS}
            className="input input-sm w-24"
            value={maxResults}
            disabled={!canManage}
            onChange={e =>
              setMaxResults(
                Math.min(WEB_SEARCH_MAX_RESULTS, Math.max(1, Number(e.target.value) || 1))
              )
            }
          />
        </SettingRow>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2 pt-4">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!dirty || update.isPending}
              onClick={saveForm}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!keyAvailable || test.isPending}
              onClick={runTest}
            >
              {test.isPending ? 'Testing…' : 'Test'}
            </button>
            {settings.hasCredential && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-error"
                disabled={update.isPending}
                onClick={() => save({ apiKey: null, enabled: false }, 'API key removed')}
              >
                Remove key
              </button>
            )}
            {verdict && <TestVerdict result={verdict} />}
          </div>
        )}
      </SectionPanel>
    </div>
  )
}

function TestVerdict({ result }: { result: TestWebSearchResponse }) {
  if (result.ok) {
    return (
      <p className="text-xs text-success" role="status">
        <span className="font-medium">Connected</span> in {result.latencyMs.toLocaleString()} ms ·{' '}
        {result.resultCount} result{result.resultCount === 1 ? '' : 's'}
      </p>
    )
  }
  return (
    <p className="text-xs text-error" role="status">
      <span className="font-medium">Test failed</span> · {result.error}
      <span className="text-muted"> ({result.code})</span>
    </p>
  )
}
