/**
 * A search hit's kind as a small coloured pill — the palette and `/search/all` both use it, so a
 * kind looks the same everywhere. Its label and tone come from the provider that declares the kind.
 * Each tone is one of the kit's contrast-checked tone pairs (`--tone-*-surface` / `-border`).
 */
import type { SearchKindTone } from '@rocketflare/shared/plugins/global-search/index'
import type { KindInfo } from '../searchModel'

const TONES: Record<SearchKindTone, string> = {
  neutral: 'text-secondary bg-[var(--surface-inset)] border-[var(--border-default)]',
  info: 'text-[var(--color-info)] bg-[var(--tone-info-surface)] border-[var(--tone-info-border)]',
  success:
    'text-[var(--color-success)] bg-[var(--tone-success-surface)] border-[var(--tone-success-border)]',
  warning:
    'text-[var(--color-warning)] bg-[var(--tone-warning-surface)] border-[var(--tone-warning-border)]',
  accent:
    'text-[var(--text-primary)] bg-[var(--tone-primary-surface)] border-[var(--tone-primary-border)]',
}

export function KindBadge({ info, className = '' }: { info: KindInfo; className?: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-[7px] text-[11px] font-medium leading-[1.6] ${TONES[info.tone]} ${className}`}
      data-tone={info.tone}
      data-kind={info.kind}
    >
      {info.badge}
    </span>
  )
}
