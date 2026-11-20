import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import { Save, AlertTriangle, RefreshCcw, Sun, CalendarRange, CalendarClock } from 'lucide-react'
import { format } from 'date-fns'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Select } from '../ui/select.js'
import { api } from '../../lib/api.js'

// v1.215.0: estimate settings for the historical import.
//
// Salesforce reports all-day Events as 1440 minutes, so the import substitutes
// a cap instead. That number is a guess either way, which is exactly why it
// belongs to an admin rather than to a constant in the code.
//
// v1.222.0 adds the import window. The backfill is the expensive part of this
// feature, so an org whose usable Event data only goes back two years
// shouldn't pay to walk a third year of rows it will discard. Capped at 3
// years, the scope the SOQL query was designed and measured against.
//
// Two modes, and the difference between them is the point: a preset window
// ("2 years") keeps sliding forward as time passes, whereas a fixed date
// ("1 Aug 2024") stays put. An admin who knows their Salesforce data is only
// trustworthy after a migration or go-live date wants the second, and
// expressing that as a day count would mean re-deriving it on every reset.

const CUSTOM = 'custom'

// Presets are whole years plus the two most useful part-years. Free-entry days
// would invite values nobody can reason about against "3 years of data" — an
// admin who needs finer control picks a date instead.
const LOOKBACK_CHOICES = [
  { days: 365, key: '1y' },
  { days: 548, key: '18m' },
  { days: 730, key: '2y' },
  { days: 913, key: '30m' },
  { days: 1095, key: '3y' },
]

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_DAYS = 30
const MAX_DAYS = 1095

/** Same bounds the server enforces, so the field can't offer an invalid date. */
function dateBounds() {
  const now = Date.now()
  return {
    min: format(new Date(now - MAX_DAYS * DAY_MS), 'yyyy-MM-dd'),
    max: format(new Date(now - MIN_DAYS * DAY_MS), 'yyyy-MM-dd'),
  }
}

/**
 * Formats an ISO instant as its UTC calendar day.
 *
 * A fixed earliest date is stored as UTC midnight. Rendering that instant with
 * plain local-time formatting shows the PREVIOUS day for anyone west of UTC —
 * an admin who typed 1 Aug 2024 was told the import would go back to 31 Jul.
 */
function formatUtcDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return format(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), 'MMM d, yyyy')
}

export function HistoricalSettings({
  allDayCapHours,
  lookbackDays,
  earliestDate,
  effectiveFloorAt,
  earliestDateClamped,
  recomputeNeeded,
  hasProgress,
  onChanged,
}: {
  allDayCapHours: number
  lookbackDays: number
  /** Fixed earliest date (yyyy-MM-dd), or null when a preset window is in effect. */
  earliestDate: string | null
  /** ISO instant the next Reset cursor would use as the floor. */
  effectiveFloorAt: string | null
  /** True when a saved fixed date has aged past the 3-year cap. */
  earliestDateClamped?: boolean
  recomputeNeeded: boolean
  /** True once the backfill has committed at least one slice against the current floor. */
  hasProgress?: boolean
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [value, setValue] = useState(String(allDayCapHours))
  const [lookback, setLookback] = useState(earliestDate ? CUSTOM : String(lookbackDays))
  const [customDate, setCustomDate] = useState(earliestDate ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bounds = useMemo(dateBounds, [])
  const isCustom = lookback === CUSTOM

  useEffect(() => {
    setValue(String(allDayCapHours))
  }, [allDayCapHours])
  useEffect(() => {
    setLookback(earliestDate ? CUSTOM : String(lookbackDays))
    setCustomDate(earliestDate ?? '')
  }, [lookbackDays, earliestDate])

  const save = async () => {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0 || n > 24) {
      setError(t('errors.historical.invalid_cap'))
      return
    }

    // Custom sends the date and clears the preset; a preset sends the day count
    // and clears the date. Sending both would leave the server deciding which
    // one the admin actually meant.
    let body: Record<string, unknown>
    if (isCustom) {
      if (!customDate || customDate < bounds.min || customDate > bounds.max) {
        setError(t('errors.historical.invalid_earliest_date'))
        return
      }
      body = { allDayCapHours: n, earliestDate: customDate }
    } else {
      const days = Number(lookback)
      if (!Number.isFinite(days) || days < MIN_DAYS || days > MAX_DAYS) {
        setError(t('errors.historical.invalid_lookback'))
        return
      }
      body = { allDayCapHours: n, lookbackDays: days, earliestDate: null }
    }

    setBusy(true)
    setError(null)
    try {
      await api.put('/api/admin/historical-import/settings', body)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Stored estimates only change when the relink pass runs, so surface the gap
  // rather than letting the displayed numbers quietly disagree with the setting.
  const recompute = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/admin/historical-import/relink', {})
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Sun className="h-4 w-4" />
        {t('admin.historical_import.settings.title')}
      </h3>
      <p className="mt-0.5 max-w-2xl text-xs text-gray-500 dark:text-gray-400">
        {t('admin.historical_import.settings.all_day_cap_help', { context: crmCtx })}
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('admin.historical_import.settings.all_day_cap', { context: crmCtx })}
          </span>
          <Input
            type="number"
            step="0.25"
            min="0.25"
            max="24"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-32"
          />
        </label>
        {/* Form context, so a native Select per §19b — it lines up with the
            Input's height, which a chip picker wouldn't. */}
        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300">
            <CalendarRange className="h-3 w-3" />
            {t('admin.historical_import.settings.lookback')}
          </span>
          <Select value={lookback} onChange={(e) => setLookback(e.target.value)} className="w-40">
            {LOOKBACK_CHOICES.map((c) => (
              <option key={c.days} value={String(c.days)}>
                {t(`admin.historical_import.settings.lookback_${c.key}`)}
              </option>
            ))}
            <option value={CUSTOM}>{t('admin.historical_import.settings.lookback_custom')}</option>
          </Select>
        </label>
        {isCustom && (
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300">
              <CalendarClock className="h-3 w-3" />
              {t('admin.historical_import.settings.earliest_date')}
            </span>
            <Input
              type="date"
              min={bounds.min}
              max={bounds.max}
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              className="w-44"
            />
          </label>
        )}
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {t('admin.historical_import.settings.save')}
        </Button>

        {recomputeNeeded && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3" />
              {t('admin.historical_import.settings.stale')}
            </span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void recompute()}>
              <RefreshCcw className="mr-1 h-3.5 w-3.5" />
              {t('admin.historical_import.settings.recompute')}
            </Button>
          </div>
        )}
      </div>

      {recomputeNeeded && (
        <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
          {t('admin.historical_import.settings.stale_help', { context: crmCtx })}
        </p>
      )}
      {/* Saving the window doesn't move an in-flight backfill's floor — doing
          so would either abandon imported rows or re-walk covered ground. Say
          so, since "saved" otherwise implies it took effect immediately. */}
      <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
        {hasProgress
          ? t('admin.historical_import.settings.lookback_help_reset')
          : t('admin.historical_import.settings.lookback_help', { context: crmCtx })}
        {effectiveFloorAt && (
          <>
            {' '}
            {t('admin.historical_import.settings.effective_floor', {
              date: formatUtcDay(effectiveFloorAt),
            })}
          </>
        )}
      </p>
      {/* A fixed date eventually ages past the 3-year cap. Quietly widening the
          scope there would be worse than pulling it forward and saying so. */}
      {earliestDateClamped && (
        <p className="mt-2 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {t('admin.historical_import.settings.earliest_date_clamped')}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}
