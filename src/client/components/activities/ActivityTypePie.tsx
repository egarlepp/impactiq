import { useTranslation } from 'react-i18next'
import { addDays, isSameDay } from 'date-fns'
import { PieChart } from 'lucide-react'
import type { Activity } from '../../hooks/useActivities.js'

interface Props {
  activities: Activity[]
  weekStart: Date
}

const FALLBACK_COLOR = '#94A3B8'

export function ActivityTypePie({ activities, weekStart }: Props) {
  const { t } = useTranslation()
  const days7 = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const inWeek = activities.filter((a) => days7.some((d) => isSameDay(new Date(a.startDatetime), d)))

  const byType = new Map<string, { name: string; color: string; hours: number }>()
  for (const a of inWeek) {
    const key = a.activityTypeId
    const entry = byType.get(key) ?? {
      name: a.activityTypeName ?? '—',
      color: a.activityTypeColor ?? FALLBACK_COLOR,
      hours: 0,
    }
    entry.hours += Number(a.effortHours)
    byType.set(key, entry)
  }
  const rows = Array.from(byType.values()).sort((a, b) => b.hours - a.hours)
  const total = rows.reduce((s, r) => s + r.hours, 0)

  const R = 32
  const CIRC = 2 * Math.PI * R
  let cursor = 0
  const slices = rows.map((r) => {
    const len = total > 0 ? (r.hours / total) * CIRC : 0
    const seg = { color: r.color, len, offset: -cursor }
    cursor += len
    return seg
  })

  return (
    <div className="border-t border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
          <PieChart className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
          {t('activities.type_pie.title')}
        </span>
        <span className="text-[10px] text-gray-500 dark:text-gray-400">
          {total.toFixed(1)}h
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-2 text-[11px] text-gray-500 dark:text-gray-400">{t('activities.type_pie.empty')}</p>
      ) : (
        <div className="flex items-center gap-3">
          <svg viewBox="-40 -40 80 80" className="h-24 w-24 -rotate-90">
            <circle r={R} cx={0} cy={0} fill="none" stroke="#E5E7EB" strokeWidth={12} />
            {slices.map((s, i) => (
              <circle
                key={i}
                r={R}
                cx={0}
                cy={0}
                fill="none"
                stroke={s.color}
                strokeWidth={12}
                strokeDasharray={`${s.len} ${CIRC - s.len}`}
                strokeDashoffset={s.offset}
              />
            ))}
          </svg>
          <ul className="flex max-h-28 flex-1 flex-col gap-1 overflow-y-auto text-[11px]">
            {rows.map((r) => {
              const pct = total > 0 ? Math.round((r.hours / total) * 100) : 0
              return (
                <li key={r.name} className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: r.color }} />
                  <span className="flex-1 truncate text-gray-700 dark:text-gray-300">{r.name}</span>
                  <span className="text-gray-500 dark:text-gray-400">{r.hours.toFixed(1)}h · {pct}%</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
