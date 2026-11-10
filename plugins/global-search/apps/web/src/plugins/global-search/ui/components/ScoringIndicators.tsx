/**
 * The small indicators in a search result's upper right (`/search/all`, and compact in ⌘K): how
 * the hit was found (`name` / `keyword` / `meaning`), its fused RRF score, and — when a re-ranker
 * ran — its move (`↑3`, `↓2`, `=`) and score. Each one's numbers are its tooltip AND screen-reader
 * text, so nothing hides behind a mouse.
 */
import type { SearchScoring } from '@rocketflare/shared/plugins/global-search/index'
import { scoringIndicators } from '../searchModel'

const PILL =
  'inline-flex items-center rounded border border-[var(--border-subtle)] px-1 text-[10px] leading-4 text-muted'

export function ScoringIndicators({
  scoring,
  providerLabel,
  rerankModel,
  compact = false,
  className = '',
}: {
  scoring: SearchScoring | undefined
  providerLabel?: (id: string) => string
  rerankModel?: string
  /** ⌘K: the signals and the move only, no fused number. */
  compact?: boolean
  className?: string
}) {
  const ind = scoringIndicators(scoring, providerLabel, rerankModel)
  if (!ind) return null
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 ${className}`}
      data-testid="scoring-indicators"
    >
      {ind.signals.map(s => (
        <span key={s.label} className={PILL} title={s.detail} data-signal={s.label}>
          {s.label}
          <span className="sr-only"> — {s.detail}</span>
        </span>
      ))}
      {!compact && (
        <span className="text-[10px] tabular-nums text-muted" title="Fused RRF score">
          <span className="sr-only">Fused score </span>
          {ind.fused}
        </span>
      )}
      {ind.move && (
        <span
          className={`${PILL} tabular-nums ${ind.move.direction === 'same' ? '' : 'text-secondary'}`}
          title={ind.move.detail}
          data-move={ind.move.direction}
        >
          {ind.move.mark}
          {!compact && <span className="ml-1">{ind.move.score}</span>}
          <span className="sr-only"> — {ind.move.detail}</span>
        </span>
      )}
    </span>
  )
}
