import { useState } from 'react'
import { format } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { Users, User, Palmtree } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { ymdInTZ, tzAbbrev } from '../../lib/tz.js'
import { bucketBlocksByDay, freeIntervals, intersectFree, minutesToLabel } from '../../lib/scheduling.js'
import type { SchedUser } from '../../hooks/useSchedulingWeek.js'

const DAY_START_MIN = 8 * 60
const DAY_END_MIN = 18 * 60
const MIN_SLOT = 30 // ignore free gaps shorter than this many minutes

// v1.153.0: free-time finder. Default shows common slots where EVERY
// selected user is free (great for "when can we all meet"); a toggle
// switches to a per-user breakdown of each person's open blocks.
// v1.343.0: third mode — who's on PTO this week, per day, filtered down to
// just the users who actually have it (rather than making someone scan the
// full per-user breakdown for the amber PTO label on a busy team).
export function FreeTimePanel({ days, users, tz, weekStart }: { days: Date[]; users: SchedUser[]; tz: string | null; weekStart: Date }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'common' | 'per_user' | 'pto'>('common')

  const dayYmds = days.map((d) => ymdInTZ(d, tz))
  const perUserByDay = users.map((u) => bucketBlocksByDay(u, dayYmds, tz))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('scheduling.free_time', 'Free time')}</span>
        <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5 text-[10px] dark:border-gray-700 dark:bg-gray-900">
          <button type="button" onClick={() => setMode('common')} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5', mode === 'common' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300')}><Users className="h-3 w-3" />{t('scheduling.free_common', 'Common')}</button>
          <button type="button" onClick={() => setMode('per_user')} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5', mode === 'per_user' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300')}><User className="h-3 w-3" />{t('scheduling.free_per_user', 'Per User')}</button>
          <button type="button" onClick={() => setMode('pto')} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5', mode === 'pto' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300')}><Palmtree className="h-3 w-3" />{t('scheduling.free_pto', 'PTO')}</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {days.map((day, dayIdx) => {
          const ymd = format(day, 'yyyy-MM-dd')
          // Per-user free intervals for this day (PTO day = no free time).
          const perUserFree = users.map((u, ui) => {
            if (u.pto.includes(ymd)) return []
            return freeIntervals(perUserByDay[ui]![dayIdx]!, DAY_START_MIN, DAY_END_MIN)
          })

          if (mode === 'common') {
            const common = intersectFree(perUserFree, DAY_START_MIN, DAY_END_MIN).filter((f) => f.endMin - f.startMin >= MIN_SLOT)
            if (common.length === 0) return null
            return (
              <div key={ymd} className="mb-2">
                <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">{format(day, 'EEE M/d')}</div>
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {common.map((f, i) => (
                    <div key={i} className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {minutesToLabel(f.startMin)}–{minutesToLabel(f.endMin)} · {t('scheduling.all_free', 'all {{n}} free', { n: users.length })}
                    </div>
                  ))}
                </div>
              </div>
            )
          }

          if (mode === 'pto') {
            const ptoUsers = users.filter((u) => u.pto.includes(ymd))
            if (ptoUsers.length === 0) return null
            return (
              <div key={ymd} className="mb-2">
                <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">{format(day, 'EEE M/d')}</div>
                <div className="mt-0.5 flex flex-col gap-1">
                  {ptoUsers.map((u) => (
                    <div key={u.userId} className="text-[10px]">
                      <span className="text-gray-500 dark:text-gray-400">{u.displayName}{u.timezone ? ` [${tzAbbrev(u.timezone, weekStart)}]` : ''}:</span>{' '}
                      <span className="text-amber-600 dark:text-amber-400">{t('scheduling.pto', 'PTO')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          }

          // per_user mode
          return (
            <div key={ymd} className="mb-2">
              <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">{format(day, 'EEE M/d')}</div>
              <div className="mt-0.5 flex flex-col gap-1">
                {users.map((u, ui) => {
                  const free = perUserFree[ui]!.filter((f) => f.endMin - f.startMin >= MIN_SLOT)
                  return (
                    <div key={u.userId} className="text-[10px]">
                      <span className="text-gray-500 dark:text-gray-400">{u.displayName}{u.timezone ? ` [${tzAbbrev(u.timezone, weekStart)}]` : ''}:</span>{' '}
                      {u.pto.includes(ymd)
                        ? <span className="text-amber-600 dark:text-amber-400">{t('scheduling.pto', 'PTO')}</span>
                        : free.length === 0
                          ? <span className="text-gray-400">{t('scheduling.no_free', 'no open time')}</span>
                          : free.map((f) => `${minutesToLabel(f.startMin)}–${minutesToLabel(f.endMin)}`).join(', ')}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
