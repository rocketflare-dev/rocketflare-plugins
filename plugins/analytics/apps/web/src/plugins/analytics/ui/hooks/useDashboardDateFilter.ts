/**
 * Dashboard date range (D19, D20): the page-level "last 7 / 30 / 90 days / custom" control,
 * synced to the URL (`?range=7d|30d|90d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD`, or
 * `?range=rel&rel=<relative range>` for a choice made in drizzle-cube's own filter bar) so a
 * dashboard link carries its window and the browser back button restores it. The value feeds the
 * template's `isUniversalTime` dashboard filter: `dashboardDateFilters(config, range)` returns
 * override copies of every universal-time filter with the new `values`, and drizzle-cube merges
 * them into the dashboard by filter id (`AnalyticsDashboard dashboardFilters`). Only strings the
 * server's relative-range parser recognises are ever emitted (`RELATIVE_RANGE`, or an ISO pair):
 * the server rejects anything else with a 400, so anything unparseable in the URL falls back to
 * the default.
 */
import type { DashboardConfig } from 'drizzle-cube/client'
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

/** One dashboard-level filter as drizzle-cube types it (`DashboardConfig['filters'][n]`). */
export type DashboardFilter = NonNullable<DashboardConfig['filters']>[number]

export type DateRangePreset = '7d' | '30d' | '90d' | 'custom' | 'rel'

/** The presets the page control offers as buttons. */
export type ButtonPreset = Exclude<DateRangePreset, 'custom' | 'rel'>

export const DATE_RANGE_PRESETS: { key: ButtonPreset; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
]

/** Matches the template's `'last 90 days'` default. */
export const DEFAULT_DATE_RANGE_PRESET: ButtonPreset = '90d'

/** drizzle-cube's relative form: `last <n> days`. */
const PRESET_VALUES: Record<ButtonPreset, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
}

/** The relative ranges drizzle-cube's server parses (lower case only). */
const RELATIVE_RANGE = new RegExp(
  '^(today|yesterday|tomorrow' +
    '|last [1-9]\\d{0,3} (days|weeks|months|quarters|years)' +
    '|(this|last|next) (week|month|quarter|year))$'
)

/** A cube date range: one relative string or an inclusive ISO-date pair. */
export type DateRangeValue = string | [string, string]

export interface DateFilterState {
  preset: DateRangePreset
  /** ISO dates, only meaningful when `preset === 'custom'`. */
  from?: string
  to?: string
  /** A `RELATIVE_RANGE` string, only meaningful when `preset === 'rel'`. */
  rel?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
}

/** A relative range → state (a button preset when one matches); null if the server rejects it. */
function relativeState(value: string | null): DateFilterState | null {
  if (value === null || !RELATIVE_RANGE.test(value)) return null
  const preset = DATE_RANGE_PRESETS.find(p => PRESET_VALUES[p.key] === value)?.key
  return preset ? { preset } : { preset: 'rel', rel: value }
}

function customState(from: string | null, to: string | null): DateFilterState | null {
  return isIsoDate(from) && isIsoDate(to) && from <= to ? { preset: 'custom', from, to } : null
}

/** URL → state; anything unparseable (unknown preset, bad or inverted dates) is the default. */
export function parseDateFilterParams(params: URLSearchParams): DateFilterState {
  const range = params.get('range')
  if (range === '7d' || range === '30d' || range === '90d') return { preset: range }
  const parsed =
    range === 'custom'
      ? customState(params.get('from'), params.get('to'))
      : range === 'rel'
        ? relativeState(params.get('rel'))
        : null
  return parsed ?? { preset: DEFAULT_DATE_RANGE_PRESET }
}

/**
 * A date filter's value, as drizzle-cube's filter bar reports it (a relative string, alone or in
 * a one-element array, or an ISO pair) → state; null for anything the page cannot represent.
 */
export function dateFilterStateOf(value: unknown): DateFilterState | null {
  const values: unknown[] = Array.isArray(value) ? value : [value]
  if (!values.every(v => typeof v === 'string')) return null
  const strings = values as string[]
  if (strings.length === 1) return relativeState(strings[0] ?? null)
  if (strings.length === 2) return customState(strings[0] ?? null, strings[1] ?? null)
  return null
}

/** State → the query-string entries (only the keys the state needs). */
export function dateFilterParams(state: DateFilterState): Record<string, string> {
  if (state.preset === 'custom' && state.from && state.to) {
    return { range: 'custom', from: state.from, to: state.to }
  }
  if (state.preset === 'rel' && state.rel) return { range: 'rel', rel: state.rel }
  return { range: buttonPresetOf(state) }
}

function buttonPresetOf(state: DateFilterState): ButtonPreset {
  return state.preset === 'custom' || state.preset === 'rel'
    ? DEFAULT_DATE_RANGE_PRESET
    : state.preset
}

/** State → the value drizzle-cube receives in `filter.values`. */
export function dateRangeValue(state: DateFilterState): DateRangeValue {
  if (state.preset === 'custom' && state.from && state.to) return [state.from, state.to]
  if (state.preset === 'rel' && state.rel) return state.rel
  return PRESET_VALUES[buttonPresetOf(state)]
}

/**
 * Overrides for every `isUniversalTime` filter in `config` carrying `range` as its values and
 * its `dateRange` — drizzle-cube merges them by `id`, so portlets mapped to the filter follow the
 * page control and portlets with their own window (a "last 30 days" KPI) are untouched.
 * `dateRange` must be overridden too: drizzle-cube reads it before `values`, and its filter
 * editor saves one.
 * Pure — unit-tested.
 */
export function dashboardDateFilters(
  config: Pick<DashboardConfig, 'filters'> | undefined,
  range: DateRangeValue
): DashboardFilter[] {
  const values = Array.isArray(range) ? range : [range]
  return (config?.filters ?? [])
    .filter(f => f.isUniversalTime && f.id)
    .map(f => ({ ...f, filter: { ...f.filter, values, dateRange: range } }))
}

/** Human label for the control's current value. */
export function dateRangeLabel(state: DateFilterState): string {
  if (state.preset === 'custom' && state.from && state.to) return `${state.from} → ${state.to}`
  if (state.preset === 'rel' && state.rel) return state.rel[0]?.toUpperCase() + state.rel.slice(1)
  const preset = buttonPresetOf(state)
  return DATE_RANGE_PRESETS.find(p => p.key === preset)?.label ?? preset
}

/** The URL-synced control state. Other query params on the page are preserved. */
export function useDashboardDateFilter() {
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => parseDateFilterParams(params), [params])
  const range = useMemo(() => dateRangeValue(state), [state])

  const apply = useCallback(
    (next: DateFilterState) => {
      setParams(
        prev => {
          const out = new URLSearchParams(prev)
          for (const key of ['range', 'from', 'to', 'rel']) out.delete(key)
          for (const [k, v] of Object.entries(dateFilterParams(next))) out.set(k, v)
          return out
        },
        { replace: true }
      )
    },
    [setParams]
  )

  const setPreset = useCallback((preset: ButtonPreset) => apply({ preset }), [apply])
  const setCustom = useCallback(
    (from: string, to: string) => {
      if (isIsoDate(from) && isIsoDate(to) && from <= to) apply({ preset: 'custom', from, to })
    },
    [apply]
  )
  /** A value from drizzle-cube's own filter bar; one the page cannot represent is ignored. */
  const setFromFilter = useCallback(
    (value: unknown) => {
      const next = dateFilterStateOf(value)
      if (next) apply(next)
    },
    [apply]
  )

  return { state, range, label: dateRangeLabel(state), setPreset, setCustom, setFromFilter }
}
