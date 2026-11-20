import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'

const KEY = 'fiscal_year.config'

export interface FiscalConfig {
  mode: 'calendar' | 'fiscal'
  startMonth: number    // 1..12, first month of Q1
  yearNaming: 'same' | 'next'  // fiscal year label = same calendar year vs next calendar year
}

export const DEFAULT_FISCAL: FiscalConfig = { mode: 'calendar', startMonth: 1, yearNaming: 'same' }

export async function getFiscalConfig(): Promise<FiscalConfig> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1)
  if (!row) return DEFAULT_FISCAL
  const v = row.value as Partial<FiscalConfig>
  return {
    mode: v.mode === 'fiscal' ? 'fiscal' : 'calendar',
    startMonth: Math.min(12, Math.max(1, Number(v.startMonth) || 1)),
    yearNaming: v.yearNaming === 'next' ? 'next' : 'same',
  }
}

export async function setFiscalConfig(cfg: FiscalConfig): Promise<void> {
  const existing = await db.select({ key: systemSettings.key }).from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1)
  const value = { mode: cfg.mode, startMonth: cfg.startMonth, yearNaming: cfg.yearNaming }
  if (existing.length > 0) {
    await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, KEY))
  } else {
    await db.insert(systemSettings).values({ key: KEY, value })
  }
}

// Compute the fiscal quarter (1..4) and label year for a given date.
export function fiscalPeriodOf(date: Date, cfg: FiscalConfig): { quarter: number; year: number; label: string } {
  const m = date.getMonth() + 1  // 1..12
  const y = date.getFullYear()
  if (cfg.mode === 'calendar') {
    const q = Math.ceil(m / 3)
    return { quarter: q, year: y, label: `Q${q} ${y}` }
  }
  // Fiscal: offset months so the fiscal year starts at startMonth.
  const monthsFromStart = (m - cfg.startMonth + 12) % 12  // 0..11
  const q = Math.floor(monthsFromStart / 3) + 1
  // Which calendar year contains fiscal Q1? If today's month is >= startMonth,
  // the fiscal year "began" this calendar year; otherwise it began last year.
  const fiscalStartYear = m >= cfg.startMonth ? y : y - 1
  const labelYear = cfg.yearNaming === 'next' ? fiscalStartYear + 1 : fiscalStartYear
  return { quarter: q, year: labelYear, label: `Q${q} FY${String(labelYear).slice(-2)}` }
}
