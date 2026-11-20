import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { busyHours } from '../../lib/scheduling.js'
import { tzAbbrev } from '../../lib/tz.js'
import type { SchedUser } from '../../hooks/useSchedulingWeek.js'

// v1.153.0: weekly capacity panel (bottom of the right column). Shows an
// aggregate team utilization bar plus an expandable per-user breakdown.
// Per-user rows honor the same privacy as the rest of the page — a
// contributor only ever sees named rows for themselves; peers stay
// anonymized (server-controlled displayName).
export function SchedulingCapacityPanel({ users, weekStart }: { users: SchedUser[]; weekStart: Date }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const totalBusy = users.reduce((s, u) => s + busyHours(u), 0)
  const totalCap = users.reduce((s, u) => s + (u.capacityHours ?? 0), 0)
  const pct = totalCap > 0 ? Math.round((totalBusy / totalCap) * 100) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('scheduling.weekly_cap', 'Weekly capacity')}</div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-gray-600 dark:text-gray-300">
        <span>{totalBusy.toFixed(1)}h / {totalCap.toFixed(0)}h</span>
        <span className={cn('font-medium', pct > 100 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-700 dark:text-gray-200')}>{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
        <div className={cn('h-full rounded', pct > 100 ? 'bg-rose-500' : 'bg-indigo-500')} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>

      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-2 flex items-center gap-1 text-[10px] text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {t('scheduling.per_user_breakdown', 'Per-user breakdown')}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {users.map((u) => {
            const busy = busyHours(u)
            const cap = u.capacityHours ?? 0
            const upct = cap > 0 ? Math.round((busy / cap) * 100) : 0
            return (
              <div key={u.userId} className="text-[10px]">
                <div className="flex items-center justify-between">
                  <span className="truncate text-gray-600 dark:text-gray-300">{u.displayName}{u.timezone ? ` [${tzAbbrev(u.timezone, weekStart)}]` : ''}</span>
                  <span className="text-gray-500 dark:text-gray-400">{busy.toFixed(1)}/{cap.toFixed(0)}h</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                  <div className={cn('h-full rounded', upct > 100 ? 'bg-rose-500' : 'bg-indigo-400')} style={{ width: `${Math.min(100, upct)}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
