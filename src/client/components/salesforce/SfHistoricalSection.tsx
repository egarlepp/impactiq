import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import { format } from 'date-fns'
import { History, ChevronDown, ChevronRight, Tag, User } from 'lucide-react'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import {
  EstimatedHours,
  PreImpactIqBadge,
  EstimatedBadge,
  HistoricalEstimateBanner,
  RecurringBadge,
  AllDayBadge,
} from '../ui/historical.js'

// v1.214.0: the "Historical Salesforce Activity" section inside
// SfActivitiesModal.
//
// Extracted rather than inlined so the modal file stays readable, but the
// separation matters for a second reason: this component owns its own totals
// and never touches the modal's `totalHours` state. The modal's header number
// is authoritative logged effort; the number here is an estimate. They must
// never be added together, and keeping them in different files makes that
// harder to do by accident.

export interface HistoricalRow {
  crmEventId: string
  subject: string | null
  crmType: string | null
  activityDate: string | null
  startDatetime: string | null
  durationMinutes: number | null
  estimatedHours: string | null
  ownerCrmUserId: string | null
  ownerCrmUserName: string | null
  whatId: string | null
  whatType: string | null
  whatName: string | null
  accountId: string | null
  description: string | null
  userId: string | null
  activityTypeName: string | null
  isRecurrence: boolean
  isAllDayEvent: boolean
}

export interface HistoricalMeta {
  count: number
  estimatedHours: number
  rowsMissingDuration: number
  earliest: string | null
  latest: string | null
  truncated?: boolean
}

/** Builds the /api/history/by-sf query for the modal's current scope. */
export function buildHistoryUrl(opts: {
  teamId: string
  whatId: string
  isAccount: boolean
  scope: 'direct' | 'include_all'
  extraWhatIds?: string[]
  startDate?: string
  endDate?: string
  countOnly?: boolean
}): string {
  const params = new URLSearchParams({ teamId: opts.teamId })
  if (opts.startDate) params.set('startDate', opts.startDate)
  if (opts.endDate) params.set('endDate', opts.endDate)
  if (opts.isAccount) {
    params.set('accountId', opts.whatId)
    params.set('mode', opts.scope)
  } else {
    params.set('whatId', opts.whatId)
    if (opts.extraWhatIds && opts.extraWhatIds.length > 0) {
      params.set('whatIds', opts.extraWhatIds.join(','))
    }
  }
  if (opts.countOnly) params.set('countOnly', '1')
  return `/api/history/by-sf?${params.toString()}`
}

export function SfHistoricalSection({
  url,
  count,
  estimatedHours,
}: {
  /** Full-fetch URL (without countOnly). */
  url: string
  /** Count from the modal's cheap countOnly probe. */
  count: number
  estimatedHours: number
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<HistoricalRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Collapse again whenever the scope changes, and drop any stale rows.
  useEffect(() => {
    setOpen(false)
    setRows([])
    setLoaded(false)
  }, [url])

  // Lazy: rows are only fetched once the user actually expands.
  useEffect(() => {
    if (!open || loaded) return
    let cancelled = false
    setLoading(true)
    void api.get<HistoricalRow[]>(url).then((res) => {
      if (cancelled) return
      setRows(res.data ?? [])
      setLoaded(true)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, loaded, url])

  // One level of grouping (year) — this is reference data, not something
  // anyone scans day by day.
  const byYear = useMemo(() => {
    const groups = new Map<string, HistoricalRow[]>()
    for (const r of rows) {
      const y = r.activityDate ? r.activityDate.slice(0, 4) : '—'
      const list = groups.get(y) ?? []
      list.push(r)
      groups.set(y, list)
    }
    return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [rows])

  // Nothing to show: render nothing at all rather than an empty accordion.
  if (count === 0) return null

  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/40 dark:border-amber-900/50 dark:bg-amber-950/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {t('sf_activities.historical_section', { context: crmCtx })}
          </span>
          <PreImpactIqBadge />
          <EstimatedBadge />
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
          {t('sf_activities.historical_count', {
            count,
            hours: estimatedHours.toFixed(1),
          })}
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-amber-200 px-3 py-3 dark:border-amber-900/50">
          <HistoricalEstimateBanner variant="compact" className="mb-3" />
          {loading && (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          )}
          {!loading && rows.length === 0 && (
            <p className="py-2 text-center text-xs text-gray-500 dark:text-gray-400">
              {t('sf_activities.historical_empty', { context: crmCtx })}
            </p>
          )}
          {!loading &&
            byYear.map(([year, items]) => (
              <div key={year} className="mb-3 last:mb-0">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-400">
                  {year} · {items.length}
                </p>
                <ul className="space-y-1">
                  {items.map((r) => (
                    <li
                      key={r.crmEventId}
                      className={cn(
                        'rounded border border-amber-100 bg-white px-2 py-1.5 text-xs',
                        'dark:border-amber-900/40 dark:bg-gray-900',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium text-gray-800 dark:text-gray-100">
                          {r.subject || t('sf_activities.historical_no_subject')}
                        </span>
                        <EstimatedHours hours={r.estimatedHours} className="shrink-0 text-xs" />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                        {r.activityDate && (
                          <span>{format(new Date(`${r.activityDate}T00:00:00`), 'd MMM yyyy')}</span>
                        )}
                        {/* Raw SF Type text, not an ImpactIQ activity type —
                            these are three years of uncleaned picklist values. */}
                        {(r.activityTypeName || r.crmType) && (
                          <span className="inline-flex items-center gap-1">
                            <Tag className="h-3 w-3" />
                            {r.activityTypeName ?? r.crmType}
                          </span>
                        )}
                        {r.isRecurrence && <RecurringBadge />}
                        {r.isAllDayEvent && <AllDayBadge />}
                        {r.ownerCrmUserName && (
                          <span className="inline-flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {r.ownerCrmUserName}
                            {/* Make the gap visible rather than confusing. */}
                            {!r.userId && (
                              <span className="text-gray-400 dark:text-gray-500">
                                {t('history.owner_not_in_app')}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
