import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Timer } from 'lucide-react'
import { api } from '../../lib/api.js'
import { useFiscalConfig, fiscalLabelOf } from '../../hooks/useFiscalConfig.js'

// End-of-fiscal-quarter for a given date under a fiscal config. In calendar
// mode Q1=Jan-Mar; in fiscal mode quarters are 3-month blocks aligned to
// cfg.startMonth. Returned date is midnight on the first day of the NEXT
// quarter (exclusive end).
function fiscalQuarterEnd(now: Date, cfg: { mode: 'calendar' | 'fiscal'; startMonth: number }): Date {
  const m = now.getMonth() + 1
  const monthsFromStart = cfg.mode === 'fiscal' ? (m - cfg.startMonth + 12) % 12 : (m - 1) % 12
  const qStartMonthIndex = Math.floor(monthsFromStart / 3) * 3
  const startMonthCalendar = cfg.mode === 'fiscal'
    ? ((cfg.startMonth - 1 + qStartMonthIndex) % 12) + 1
    : qStartMonthIndex + 1
  const start = new Date(now.getFullYear(), startMonthCalendar - 1, 1)
  if (start > now) start.setFullYear(start.getFullYear() - 1)
  const end = new Date(start)
  end.setMonth(end.getMonth() + 3)
  return end
}

// Count business days (Mon-Fri) from `from` (exclusive of days before today)
// to `to` (exclusive). Subtracts any dates in the `holidays` set that fall
// on weekdays.
function businessDaysBetween(from: Date, to: Date, holidays: Set<string>): number {
  let count = 0
  const cur = new Date(from)
  cur.setHours(0, 0, 0, 0)
  while (cur < to) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) {
      const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`
      if (!holidays.has(iso)) count++
    }
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

// Total calendar days from `from` (inclusive of today) to `to` (exclusive) —
// the same window businessDaysBetween counts, just with no weekday/holiday
// exclusion. Computed via a whole-day ms difference rather than a loop since
// there's nothing to skip.
function calendarDaysBetween(from: Date, to: Date): number {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  return Math.round((end.getTime() - start.getTime()) / 86400000)
}

export function QuarterCountdown() {
  const { t } = useTranslation()
  const cfg = useFiscalConfig()
  const [holidayDates, setHolidayDates] = useState<Set<string>>(new Set())

  useEffect(() => {
    const now = new Date()
    const qEnd = fiscalQuarterEnd(now, cfg)
    const startStr = now.toISOString().slice(0, 10)
    const endStr = qEnd.toISOString().slice(0, 10)
    api.get<{ date: string; name: string }[]>(`/auth/me/holidays?start=${startStr}&end=${endStr}`)
      .then((res) => {
        const s = new Set<string>()
        for (const d of res.data ?? []) s.add(d.date)
        setHolidayDates(s)
      })
      .catch(() => {})
  }, [cfg.mode, cfg.startMonth])

  const { daysLeft, calendarDaysLeft, label } = useMemo(() => {
    const now = new Date()
    const qEnd = fiscalQuarterEnd(now, cfg)
    return {
      daysLeft: businessDaysBetween(now, qEnd, holidayDates),
      calendarDaysLeft: calendarDaysBetween(now, qEnd),
      label: fiscalLabelOf(now, cfg),
    }
  }, [cfg, holidayDates])

  const tooltip = t('nav.quarter_countdown.tooltip', {
    label,
    businessDays: daysLeft,
    calendarDays: calendarDaysLeft,
    defaultValue: '{{label}} · {{businessDays}} business days left / {{calendarDays}} calendar days left',
  })

  return (
    <span
      title={tooltip}
      className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-white px-2 py-1 text-xs font-medium text-indigo-700 shadow-sm dark:border-indigo-800 dark:bg-gray-900 dark:text-indigo-300"
    >
      <Timer className="h-3.5 w-3.5" />
      <span className="tabular-nums">{daysLeft}/{calendarDaysLeft}</span>
    </span>
  )
}
