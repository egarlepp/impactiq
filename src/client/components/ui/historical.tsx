import { useTranslation } from 'react-i18next'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import { History, Sigma, Info, Repeat, Sun } from 'lucide-react'
import { cn } from '../../lib/utils.js'

// v1.214.0: the shared vocabulary for pre-ImpactIQ Salesforce activity.
//
// Historical hours are ESTIMATES derived from the meeting length scheduled in
// Salesforce — nobody logged them — and they are excluded from every cost and
// capacity figure in the app. The failure mode this file exists to prevent is
// someone reading an estimate as measured effort and putting it in a QBR.
//
// Everything historical is amber; every live surface in the app is blue. That
// contrast is doing real work, so keep it.

/**
 * Renders estimated hours as `~1.5h`.
 *
 * If you are formatting historical hours anywhere without this component, you
 * are doing it wrong — the `~`, the amber, and the tooltip are the whole point,
 * and a null duration must never render as `0.0h` (that reads as "no time
 * spent" when it actually means "Salesforce didn't record a length").
 */
export function EstimatedHours({
  hours,
  className,
}: {
  hours: number | string | null | undefined
  className?: string
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const n = hours == null ? null : Number(hours)
  if (n == null || !Number.isFinite(n)) {
    return (
      <span className={cn('text-xs text-gray-400 dark:text-gray-500', className)}>
        {t('history.no_duration', { context: crmCtx })}
      </span>
    )
  }
  return (
    <span
      className={cn('tabular-nums text-amber-700 dark:text-amber-400', className)}
      title={t('history.est_tooltip', { context: crmCtx })}
      aria-label={t('history.est_tooltip', { context: crmCtx })}
    >
      ~{n.toFixed(1)}h
    </span>
  )
}

const PILL =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ' +
  'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300'

export function PreImpactIqBadge({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn(PILL, className)}>
      <History className="h-3 w-3 shrink-0" />
      {t('history.badge_pre_impactiq')}
    </span>
  )
}

export function EstimatedBadge({ className }: { className?: string }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  return (
    <span className={cn(PILL, className)} title={t('history.est_tooltip', { context: crmCtx })}>
      <Sigma className="h-3 w-3 shrink-0" />
      {t('history.badge_estimated')}
    </span>
  )
}

// v1.215.0: per-row flags. These exist so the matching filter chips are
// trustworthy — a filter with no visible per-row indicator leaves the user
// guessing which rows it actually acted on.

export function RecurringBadge({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn(PILL, className)}>
      <Repeat className="h-3 w-3 shrink-0" />
      {t('history.badge_recurring')}
    </span>
  )
}

export function AllDayBadge({ className }: { className?: string }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  return (
    <span className={cn(PILL, className)} title={t('history.badge_all_day_tooltip', { context: crmCtx })}>
      <Sun className="h-3 w-3 shrink-0" />
      {t('history.badge_all_day')}
    </span>
  )
}

/**
 * The standing explanation of what this data is and what it is excluded from.
 * `full` on dedicated history pages; `compact` inside the SF activities modal.
 */
export function HistoricalEstimateBanner({
  variant = 'full',
  className,
}: {
  variant?: 'full' | 'compact'
  className?: string
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs',
        'text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200',
        className,
      )}
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{variant === 'full' ? t('history.banner_full', { context: crmCtx }) : t('history.banner_compact', { context: crmCtx })}</span>
    </div>
  )
}
