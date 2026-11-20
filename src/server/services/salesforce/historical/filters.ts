import { eq, type SQL } from 'drizzle-orm'
import { crmHistoricalEvents } from '../../../../../drizzle/schema.js'

// v1.215.0: shared read-side filters for the recurring / all-day flags on
// historical events.
//
// Deliberately a read filter, not an import filter. Recurring and all-day
// events ARE imported and stored — the decision to look at them or not belongs
// to whoever is reading, not to the ingest job. Dropping them at import would
// bake a judgement into the data where nobody could see or reverse it.
//
// One parser and one predicate builder, shared by routes/history.ts and
// routes/dashboards.ts, so a filter can't end up applied to two of a handler's
// three queries and silently desync its KPI row.

export type FlagFilter = 'all' | 'only' | 'exclude'

export interface HistoryFlagFilters {
  recurring: FlagFilter
  allDay: FlagFilter
}

export const DEFAULT_FLAG_FILTERS: HistoryFlagFilters = { recurring: 'all', allDay: 'all' }

function parseOne(v: unknown): FlagFilter {
  // Unknown values fall back to 'all'. A filter param is never worth a 400 —
  // the worst case of a typo should be "you see everything", not a broken page.
  return v === 'only' || v === 'exclude' ? v : 'all'
}

export function parseHistoryFlagFilters(query: Record<string, unknown>): HistoryFlagFilters {
  return {
    recurring: parseOne(query['recurring']),
    allDay: parseOne(query['allDay']),
  }
}

export function historyFlagConds(f: HistoryFlagFilters): SQL[] {
  const conds: SQL[] = []
  if (f.recurring !== 'all') {
    conds.push(eq(crmHistoricalEvents.isRecurrence, f.recurring === 'only'))
  }
  if (f.allDay !== 'all') {
    conds.push(eq(crmHistoricalEvents.isAllDayEvent, f.allDay === 'only'))
  }
  return conds
}
