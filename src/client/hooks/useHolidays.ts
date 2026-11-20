import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { api } from '../lib/api.js'

export interface HolidayEntry { date: string; name: string }

export function useHolidays(start: Date, end: Date): { holidays: HolidayEntry[]; byIso: Map<string, string> } {
  const [holidays, setHolidays] = useState<HolidayEntry[]>([])
  const startStr = format(start, 'yyyy-MM-dd')
  const endStr = format(end, 'yyyy-MM-dd')
  useEffect(() => {
    void api.get<HolidayEntry[]>(`/auth/me/holidays?start=${startStr}&end=${endStr}`).then((res) => {
      setHolidays(res.data ?? [])
    })
  }, [startStr, endStr])
  const byIso = new Map<string, string>()
  for (const h of holidays) byIso.set(h.date, h.name)
  return { holidays, byIso }
}
