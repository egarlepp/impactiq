import { useRef, useEffect } from 'react'
import { format } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { cn } from '../../lib/utils.js'
import { ymdInTZ, tzAbbrev } from '../../lib/tz.js'
import { bucketBlocksByDay } from '../../lib/scheduling.js'
import type { SchedUser } from '../../hooks/useSchedulingWeek.js'

// Minimum height per hour row. The rows are flex-1 so they stretch to fill
// the panel height (showing half/quarter-hour lines); if the panel is shorter
// than the visible hours × this, the grid scrolls instead of squashing.
const HOUR_MIN_PX = 26

// Workday bit mask (bit 1=Mon … bit 64=Sun, see Settings.tsx) is keyed by
// the day's actual weekday, not its position in the `days` display array —
// that position shifts with Scheduling.tsx's Sun-first/Mon-first toggle
// (v1.236.0), so this always recomputes from the date itself.
function workDayBit(d: Date): number {
  return 1 << ((d.getDay() + 6) % 7)
}

// v1.153.0: multi-user week grid for the Scheduling page. Each day column
// splits into one narrow lane per selected user; each lane stacks that
// user's busy blocks (colored by activity type; generic gray otherwise).
// Names/subjects only appear when the server marked the user
// non-anonymized (privileged viewer or the caller's own row).
//
// v1.154.0: renders the full 24-hour day, stretches the hours to fill the
// panel (with quarter/half-hour guides), and shades non-working hours +
// weekend/non-work-day columns to match the Activities Outlook calendar. The
// whole grid renders in `tz` (a teammate's zone can be selected).
export function SchedulingGrid({ days, users, tz, weekStart, hoursMode = 'all' }: { days: Date[]; users: SchedUser[]; tz: string | null; weekStart: Date; hoursMode?: 'all' | 'work' }) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const gridRef = useRef<HTMLDivElement | null>(null)

  // Logged-in user's working window + work-day mask (bit per weekday, Mon=0),
  // matching the Activities calendar defaults.
  const workStart = user?.workDayStartHour ?? 8
  const workEnd = user?.workDayEndHour ?? 18
  const workDaysMask = user?.workDays ?? 31

  // v1.163.0: the grid shows either the full 24-hour day or just the work-hours
  // band, per the header toggle.
  const gridStart = hoursMode === 'work' ? workStart : 0
  const gridEnd = hoursMode === 'work' ? Math.max(workStart + 1, workEnd) : 24
  const hours = Array.from({ length: gridEnd - gridStart }, (_, i) => gridStart + i)

  // Auto-scroll so the work-day band is in view on load (when scrolling).
  useEffect(() => { if (gridRef.current) gridRef.current.scrollTop = Math.max(0, (workStart - gridStart - 1)) * HOUR_MIN_PX }, [workStart, gridStart])

  const dayYmds = days.map((d) => ymdInTZ(d, tz))
  const perUserByDay = users.map((u) => bucketBlocksByDay(u, dayYmds, tz))
  const spanMin = (gridEnd - gridStart) * 60

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day header row with per-day busy-hours total across users. */}
      <div className="grid shrink-0 border-b border-gray-200 dark:border-gray-700" style={{ gridTemplateColumns: `44px repeat(${days.length}, minmax(0,1fr))` }}>
        <div />
        {days.map((day, dayIdx) => {
          let mins = 0
          let anyPto = false
          users.forEach((u, ui) => {
            for (const b of perUserByDay[ui]![dayIdx]!) mins += b.endMin - b.startMin
            if (u.pto.includes(format(day, 'yyyy-MM-dd'))) anyPto = true
          })
          const isWorkDay = (workDaysMask & workDayBit(day)) !== 0
          return (
            <div key={day.toISOString()} className={cn('px-1 py-1 text-center', !isWorkDay && 'bg-gray-200/70 dark:bg-black/40', anyPto && 'bg-amber-50 dark:bg-amber-950/30')}>
              <div className={cn('text-[11px] font-semibold', isWorkDay ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500')}>{format(day, 'EEE')}</div>
              <div className="text-[10px] text-gray-400 dark:text-gray-500">{format(day, 'M/d')} · {(mins / 60).toFixed(1)}h</div>
            </div>
          )
        })}
      </div>

      <div ref={gridRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="grid h-full" style={{ gridTemplateColumns: `44px repeat(${days.length}, minmax(0,1fr))`, minHeight: (gridEnd - gridStart) * HOUR_MIN_PX }}>
          {/* Hour gutter */}
          <div className="flex flex-col">
            {hours.map((h) => {
              const offHours = h < workStart || h >= workEnd
              return (
                <div key={h} className={cn('relative flex-1 border-b border-gray-100 dark:border-gray-700', offHours && 'bg-gray-50 dark:bg-black/40')} style={{ minHeight: HOUR_MIN_PX }}>
                  <span className={cn('absolute right-1 top-0 text-[10px]', offHours ? 'text-gray-300 dark:text-gray-600' : 'text-gray-400 dark:text-gray-500')}>{format(new Date().setHours(h, 0), 'h a')}</span>
                </div>
              )
            })}
          </div>

          {days.map((day, dayIdx) => {
            const isWorkDay = (workDaysMask & workDayBit(day)) !== 0
            const isPto = users.some((u) => u.pto.includes(format(day, 'yyyy-MM-dd')))
            return (
              <div
                key={day.toISOString()}
                className={cn(
                  'relative flex flex-col border-l border-gray-100 dark:border-gray-700',
                  // A non-work day (weekend) reads as entirely off — shade the
                  // whole column, visible in both light and dark mode.
                  !isWorkDay && 'bg-gray-200/70 dark:bg-black/40',
                )}
              >
                {/* hour cells with quarter/half-hour guides. Work-day off-hours
                    get the lighter off-hour tint; weekend columns are already
                    fully shaded above so we skip per-cell shading there. */}
                {hours.map((h) => {
                  const offHours = h < workStart || h >= workEnd
                  return (
                    <div key={h} className={cn('relative flex-1 border-b border-gray-100 dark:border-gray-700', isWorkDay && offHours && 'bg-gray-100/60 dark:bg-black/40')} style={{ minHeight: HOUR_MIN_PX }}>
                      {/* half-hour line (medium) + quarter lines (faint) */}
                      <div className="pointer-events-none absolute left-0 right-0 top-1/4 border-t border-gray-100/70 dark:border-gray-800/50" />
                      <div className="pointer-events-none absolute left-0 right-0 top-1/2 border-t border-gray-200/80 dark:border-gray-700/70" />
                      <div className="pointer-events-none absolute left-0 right-0 top-3/4 border-t border-gray-100/70 dark:border-gray-800/50" />
                    </div>
                  )
                })}
                {/* per-user lanes overlaid over the full day column */}
                <div className="absolute inset-0 flex">
                  {users.map((u, ui) => {
                    const blocks = perUserByDay[ui]![dayIdx]!
                    const uPto = u.pto.includes(format(day, 'yyyy-MM-dd'))
                    return (
                      <div key={u.userId} className={cn('relative min-w-0 flex-1 border-r border-gray-100/60 last:border-r-0 dark:border-gray-800/60', uPto && 'bg-amber-100/40 dark:bg-amber-900/20')}>
                        {blocks.map((b) => {
                          // Clip to the visible window (work-hours mode hides
                          // blocks outside the band; partial blocks are clamped).
                          const winStart = gridStart * 60
                          const winEnd = gridEnd * 60
                          if (b.endMin <= winStart || b.startMin >= winEnd) return null
                          const s = Math.max(b.startMin, winStart)
                          const e = Math.min(b.endMin, winEnd)
                          const top = ((s - winStart) / spanMin) * 100
                          const height = Math.max(0.8, ((e - s) / spanMin) * 100)
                          const bg = b.color ?? '#94a3b8'
                          // v1.263.0: a private meeting's label is ALWAYS
                          // "Private meeting" — never the real subject, even
                          // for the meeting's own owner viewing their own
                          // grid lane. The server already withholds the real
                          // subject from anyone but the owner (canDetail in
                          // scheduling.ts), so this is display-only masking
                          // on top of that, matching every other Private
                          // Meeting surface in the app.
                          const label = b.isPrivate ? t('activity.private_meeting.title', 'Private meeting') : b.subject
                          const title = label ? `${u.anonymized ? '' : u.displayName + ' · '}${label}` : undefined
                          return (
                            <div
                              key={b.key}
                              title={title}
                              className={cn(
                                'absolute left-0.5 right-0.5 flex items-center justify-center rounded-sm opacity-85',
                                b.isTentative && 'stripe-tentative',
                              )}
                              style={{ top: `${top}%`, height: `${height}%`, backgroundColor: bg, borderLeft: `2px solid ${bg}` }}
                            >
                              {b.isPrivate && <Lock className="h-2.5 w-2.5 shrink-0 text-white/90" aria-hidden="true" />}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
                {isPto && (
                  <div className="pointer-events-none absolute inset-x-0 top-1 z-[5] flex justify-center">
                    <div className="rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white shadow-sm">{t('scheduling.pto', 'PTO')}</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Legend / lane key — each user tagged with their timezone acronym */}
      <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-t border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {users.map((u) => (
          <span key={u.userId} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: u.isSelf ? '#2563eb' : '#94a3b8' }} />
            {u.displayName}{u.timezone ? ` [${tzAbbrev(u.timezone, weekStart)}]` : ''}{u.isSelf ? ` (${t('scheduling.you', 'you')})` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
