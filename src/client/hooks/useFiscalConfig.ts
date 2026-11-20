import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

export interface FiscalConfig {
  mode: 'calendar' | 'fiscal'
  startMonth: number
  yearNaming: 'same' | 'next'
}

const DEFAULT: FiscalConfig = { mode: 'calendar', startMonth: 1, yearNaming: 'same' }

let cached: FiscalConfig | null = null

export function useFiscalConfig(): FiscalConfig {
  const [cfg, setCfg] = useState<FiscalConfig>(cached ?? DEFAULT)
  useEffect(() => {
    if (cached) return
    api.get<FiscalConfig>('/api/admin/fiscal-year').then((res) => {
      const next = res.data ?? DEFAULT
      cached = next
      setCfg(next)
    })
  }, [])
  return cfg
}

export function fiscalLabelOf(date: Date, cfg: FiscalConfig): string {
  const m = date.getMonth() + 1
  const y = date.getFullYear()
  if (cfg.mode === 'calendar') return `Q${Math.ceil(m / 3)} ${y}`
  const monthsFromStart = (m - cfg.startMonth + 12) % 12
  const q = Math.floor(monthsFromStart / 3) + 1
  const fiscalStartYear = m >= cfg.startMonth ? y : y - 1
  const labelYear = cfg.yearNaming === 'next' ? fiscalStartYear + 1 : fiscalStartYear
  return `Q${q} FY${String(labelYear).slice(-2)}`
}
