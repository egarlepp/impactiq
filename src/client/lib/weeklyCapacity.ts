import { addDays, format, isSameDay } from 'date-fns'
import type { Activity } from '../hooks/useActivities.js'
import { useHolidays } from '../hooks/useHolidays.js'
import { usePto } from '../hooks/usePto.js'
import { workDayBit } from '../../shared/weekNav.js'

export interface WeeklyCapacity {
  hoursPerDay: number
  workingDaysInWeek: number
  holidayDaysInWeek: number
  ptoDaysInWeek: number
  ptoDayLabels: string[]
  ptoHoursExcluded: number
  capacity: number
  logged: number
  filled: number
  remaining: number
  overflow: number
  pct: number
  overCapacity: boolean
}

export function useWeeklyCapacity(
  activities: Activity[],
  weekStart: Date,
  workDays: number,
  workDayStartHour: number,
  workDayEndHour: number,
): WeeklyCapacity {
  const hoursPerDay = Math.max(1, workDayEndHour - workDayStartHour)
  const days7 = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const { byIso: holidayByIso } = useHolidays(days7[0]!, days7[6]!)
  const { ptoDates } = usePto(days7[0]!, days7[6]!)
  let workingDaysInWeek = 0
  let holidayDaysInWeek = 0
  let ptoDaysInWeek = 0
  const ptoDayLabels: string[] = []
  for (let i = 0; i < 7; i++) {
    // v1.456.2: workDays bit 0 is Monday. Index by the real weekday, not the
    // position in the week, since weekStart is a Sunday in Sunday-first mode.
    if ((workDays & workDayBit(days7[i]!)) === 0) continue
    const iso = format(days7[i]!, 'yyyy-MM-dd')
    if (holidayByIso.has(iso)) {
      holidayDaysInWeek++
      continue
    }
    if (ptoDates.has(iso)) {
      ptoDaysInWeek++
      ptoDayLabels.push(format(days7[i]!, 'EEE MMM d'))
      continue
    }
    workingDaysInWeek++
  }
  const ptoHoursExcluded = ptoDaysInWeek * hoursPerDay
  const capacity = workingDaysInWeek * hoursPerDay
  const logged = activities
    .filter((a) => days7.some((d) => isSameDay(new Date(a.startDatetime), d)))
    .reduce((s, a) => s + Number(a.effortHours), 0)
  const filled = Math.min(logged, capacity)
  const remaining = Math.max(0, capacity - logged)
  const overflow = Math.max(0, logged - capacity)
  const pct = capacity > 0 ? Math.round((logged / capacity) * 100) : 0
  return {
    hoursPerDay,
    workingDaysInWeek,
    holidayDaysInWeek,
    ptoDaysInWeek,
    ptoDayLabels,
    ptoHoursExcluded,
    capacity,
    logged,
    filled,
    remaining,
    overflow,
    pct,
    overCapacity: overflow > 0,
  }
}
