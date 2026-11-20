import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import type { Activity } from '../../hooks/useActivities.js'
import { useWeeklyCapacity } from '../../lib/weeklyCapacity.js'

interface CapacityPieProps {
  activities: Activity[]
  weekStart: Date
  workDays: number
  workDayStartHour: number
  workDayEndHour: number
  // Uncaptured Outlook meeting hours (Non-Activity / uncategorized) — shown as
  // a grey arc so the donut reflects total time used, matching the bar.
  otherMeetingHours?: number
}

const OTHER_COLOR = '#6B7280'

// Small SVG pie: two arcs — one for hours logged this week, one for remaining
// capacity. Uses the standard "single wedge on a circle" pattern with
// stroke-dasharray on a full circle so we don't have to compute arc paths.
export function CapacityPie({
  activities,
  weekStart,
  workDays,
  workDayStartHour,
  workDayEndHour,
  otherMeetingHours = 0,
}: CapacityPieProps) {
  const { t } = useTranslation()
  const cap = useWeeklyCapacity(activities, weekStart, workDays, workDayStartHour, workDayEndHour)
  const {
    hoursPerDay,
    workingDaysInWeek,
    holidayDaysInWeek,
    ptoDaysInWeek,
    ptoDayLabels,
    ptoHoursExcluded,
    capacity,
    logged,
    filled,
    overCapacity,
  } = cap
  const otherHours = Math.max(0, otherMeetingHours)
  // Combined utilization drives the centre % so a meeting-heavy week doesn't
  // read as near-empty.
  const combinedPct = capacity > 0 ? Math.round(((logged + otherHours) / capacity) * 100) : 0
  // Grey arc for other meetings fills whatever capacity the logged arc left.
  const otherFilled = Math.max(0, Math.min(otherHours, capacity - filled))
  const remaining = Math.max(0, capacity - logged - otherHours)

  const R = 32
  const CIRC = 2 * Math.PI * R
  const filledLen = capacity > 0 ? (filled / capacity) * CIRC : 0
  const otherLen = capacity > 0 ? (otherFilled / capacity) * CIRC : 0
  const remainingLen = Math.max(0, CIRC - filledLen - otherLen)

  return (
    <div className="border-t border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
          <Gauge className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          {t('activities.capacity.title')}
        </span>
        <span className="text-[10px] text-gray-500 dark:text-gray-400">
          {logged.toFixed(1)}h / {capacity}h
        </span>
      </div>
      <div className="flex items-center gap-3">
        <svg viewBox="-40 -40 80 80" className="h-24 w-24 -rotate-90">
          <circle r={R} cx={0} cy={0} fill="none" stroke="#E5E7EB" strokeWidth={12} />
          <circle
            r={R}
            cx={0}
            cy={0}
            fill="none"
            stroke={overCapacity ? '#EF4444' : '#22C55E'}
            strokeWidth={12}
            strokeDasharray={`${filledLen} ${CIRC - filledLen}`}
            strokeDashoffset={0}
          />
          {otherLen > 0 && (
            <circle
              r={R}
              cx={0}
              cy={0}
              fill="none"
              stroke={OTHER_COLOR}
              strokeWidth={12}
              strokeDasharray={`${otherLen} ${CIRC - otherLen}`}
              strokeDashoffset={-filledLen}
            />
          )}
          <text x={0} y={2} textAnchor="middle" transform="rotate(90)" className="fill-gray-800 text-[11px] font-semibold dark:fill-gray-100">
            {combinedPct}%
          </text>
        </svg>
        <div className="flex flex-1 flex-col gap-1 text-[11px]">
          <div className="flex items-center gap-2">
            <span className={overCapacity ? 'inline-block h-2 w-2 rounded-sm bg-red-500' : 'inline-block h-2 w-2 rounded-sm bg-green-500'} />
            <span className="text-gray-700 dark:text-gray-300">{t('activities.capacity.logged')}: {logged.toFixed(1)}h</span>
          </div>
          {otherHours > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: OTHER_COLOR }} />
              <span className="text-gray-700 dark:text-gray-300">{t('activity.weekly_bar.other_meetings_label')}: {otherHours.toFixed(1)}h</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-sm bg-gray-300 dark:bg-gray-600" />
            <span className="text-gray-700 dark:text-gray-300">{t('activities.capacity.remaining')}: {remaining.toFixed(1)}h</span>
          </div>
          <div className="text-[10px] text-gray-500 dark:text-gray-400">
            {t('activities.capacity.based_on', { days: workingDaysInWeek, hours: hoursPerDay })}
          </div>
          {holidayDaysInWeek > 0 && (
            <div className="text-[10px] text-indigo-600 dark:text-indigo-400">
              {t('activities.capacity.holidays_excluded', { count: holidayDaysInWeek })}
            </div>
          )}
          {ptoDaysInWeek > 0 && (
            <div className="text-[10px] text-amber-600 dark:text-amber-400" title={ptoDayLabels.join(', ')}>
              {t('activities.capacity.pto_excluded_detail', {
                count: ptoDaysInWeek,
                hours: ptoHoursExcluded.toFixed(1),
                days: ptoDayLabels.join(', '),
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
