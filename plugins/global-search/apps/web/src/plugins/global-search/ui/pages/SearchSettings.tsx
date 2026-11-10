/**
 * Settings → Search: the organisation's own re-ranker for global search — a Cohere-style
 * `POST {base}/rerank` endpoint (Cohere, Voyage AI, Fireworks AI or any compatible server), the
 * model and the key. Test it, turn it on.
 *
 * The key never comes back from the server — the page shows "Key saved" from `hasCredential`, and
 * an empty key field on save means "keep the one you have". Changing the URL without typing a new
 * key clears the old one server-side, so the page says so before it happens. Only owners and
 * admins see this tab.
 */
import {
  RERANK_PRESETS,
  type GlobalSearchSettings as Settings,
  type TestRerankResponse,
  type UpdateGlobalSearchSettings,
} from '@rocketflare/shared/plugins/global-search/index'
import { useState } from 'react'
import {
  ApiError,
  SectionPanel,
  SectionPanelSkeleton,
  SettingRow,
  SettingToggle,
  showToast,
} from '@/plugins/api/ui'
import {
  useGlobalSearchSettings,
  useTestRerank,
  useUpdateGlobalSearchSettings,
} from '../hooks/useGlobalSearch'

export default function SearchSettingsPage() {
  const settings = useGlobalSearchSettings()
  if (settings.isPending) return <SectionPanelSkeleton rows={4} />
  if (settings.isError || !settings.data) {
    return (
      <SectionPanel title="Search">
        <p className="text-sm text-error">The search settings could not be loaded.</p>
      </SectionPanel>
    )
  }
  // Keyed on `updatedAt` so a save (or a colleague's, via the nudge) resets the form to the server.
  return <SettingsForm key={String(settings.data.updatedAt)} settings={settings.data} />
}

function SettingsForm({ settings }: { settings: Settings }) {
  const update = useUpdateGlobalSearchSettings()
  const test = useTestRerank()
  const [baseUrl, setBaseUrl] = useState(settings.rerankBaseUrl ?? '')
  const [model, setModel] = useState(settings.rerankModel ?? '')
  const [apiKey, setApiKey] = useState('')
  const [verdict, setVerdict] = useState<TestRerankResponse | null>(null)

  const urlChanged = baseUrl.trim() !== (settings.rerankBaseUrl ?? '')
  const keyAvailable = apiKey.trim().length > 0 || (settings.hasCredential && !urlChanged)
  const dirty =
    urlChanged || model.trim() !== (settings.rerankModel ?? '') || apiKey.trim().length > 0
  const complete = keyAvailable && baseUrl.trim().length > 0 && model.trim().length > 0

  async function save(body: UpdateGlobalSearchSettings, done: string) {
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
        rerankBaseUrl: baseUrl.trim() || null,
        rerankModel: model.trim() || null,
        ...(apiKey.trim() && { rerankApiKey: apiKey.trim() }),
        // An incomplete configuration cannot stay switched on.
        ...(!complete && { rerankEnabled: false }),
      },
      !settings.hasCredential && apiKey.trim() && complete
        ? 'Re-ranker saved — search results are now re-ranked'
        : 'Search settings saved'
    )
  }

  async function runTest() {
    setVerdict(null)
    try {
      setVerdict(
        await test.mutateAsync({
          ...(baseUrl.trim() && { rerankBaseUrl: baseUrl.trim() }),
          ...(model.trim() && { rerankModel: model.trim() }),
          ...(apiKey.trim() && { rerankApiKey: apiKey.trim() }),
        })
      )
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'The test could not run', 'error')
    }
  }

  const canEnable =
    settings.hasCredential && Boolean(settings.rerankBaseUrl && settings.rerankModel)

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Re-ranking"
        description="Reorder the top of every search with a re-ranking model, on your organisation's own key. The query and the result titles and snippets are sent to it."
      >
        <SettingToggle
          id="global-search-rerank-enabled"
          label="Re-rank search results"
          description={
            canEnable
              ? 'When on, the top 50 results of every search are reordered by the model. If it is slow or fails, search answers in its usual order.'
              : 'Save a URL, a model and a key below to turn this on.'
          }
          checked={settings.rerankEnabled}
          disabled={update.isPending || (!settings.rerankEnabled && !canEnable)}
          onChange={rerankEnabled =>
            save(
              { rerankEnabled },
              rerankEnabled ? 'Re-ranking turned on' : 'Re-ranking turned off'
            )
          }
        />
      </SectionPanel>

      <SectionPanel title="Re-ranker" description="Any endpoint that answers POST {URL}/rerank.">
        <SettingRow label="Preset" htmlFor="global-search-preset">
          <select
            id="global-search-preset"
            className="select select-sm w-full sm:w-72"
            value={RERANK_PRESETS.find(p => p.baseUrl === baseUrl.trim())?.id ?? ''}
            onChange={e => {
              const preset = RERANK_PRESETS.find(p => p.id === e.target.value)
              if (!preset) return
              setBaseUrl(preset.baseUrl)
              setModel(preset.model)
              setVerdict(null)
            }}
          >
            <option value="">Custom</option>
            {RERANK_PRESETS.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="URL" htmlFor="global-search-url" description="https:// only.">
          <input
            id="global-search-url"
            type="url"
            className="input input-sm w-full sm:w-72"
            placeholder="https://api.cohere.com/v2"
            value={baseUrl}
            onChange={e => {
              setBaseUrl(e.target.value)
              setVerdict(null)
            }}
          />
        </SettingRow>
        <SettingRow label="Model" htmlFor="global-search-model">
          <input
            id="global-search-model"
            type="text"
            className="input input-sm w-full sm:w-72"
            placeholder="rerank-v3.5"
            value={model}
            onChange={e => {
              setModel(e.target.value)
              setVerdict(null)
            }}
          />
        </SettingRow>
        <SettingRow
          label="API key"
          htmlFor="global-search-key"
          description={
            urlChanged && settings.hasCredential && !apiKey.trim()
              ? 'Saving clears the stored key — a key belongs to one URL.'
              : settings.hasCredential && !urlChanged
                ? 'Key saved. Leave blank to keep it.'
                : 'Stored encrypted. It is never shown again after saving.'
          }
        >
          <input
            id="global-search-key"
            type="password"
            autoComplete="off"
            className="input input-sm w-full sm:w-72"
            placeholder={settings.hasCredential && !urlChanged ? '••••••••' : 'Paste key'}
            value={apiKey}
            onChange={e => {
              setApiKey(e.target.value)
              setVerdict(null)
            }}
          />
        </SettingRow>
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
            disabled={!complete || test.isPending}
            onClick={runTest}
          >
            {test.isPending ? 'Testing…' : 'Test'}
          </button>
          {settings.hasCredential && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-error"
              disabled={update.isPending}
              onClick={() =>
                save({ rerankApiKey: null, rerankEnabled: false }, 'Re-ranker key removed')
              }
            >
              Remove key
            </button>
          )}
          {verdict && <TestVerdict result={verdict} />}
        </div>
      </SectionPanel>
    </div>
  )
}

function TestVerdict({ result }: { result: TestRerankResponse }) {
  if (result.ok) {
    return (
      <p className="text-xs text-success" role="status">
        <span className="font-medium">Connected</span> in {result.latencyMs.toLocaleString()} ms ·{' '}
        {result.scored} scored
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
