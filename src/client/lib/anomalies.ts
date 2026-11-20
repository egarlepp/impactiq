// Contributor-level anomaly detection over weekly rollup data.
// Runs client-side against the same data the Team Heatmap already loads
// so we don't need a new endpoint for MVP.
//
// Rules implemented:
//   under      — < 50% of target for 2 consecutive weeks (amber)
//   silent     — no activities logged in last 5 business days (red)
//   over       — > 120% of target for 2 consecutive weeks (amber)
//   imbalance  — > 80% of hours in a single activity type over 4w (amber)

export interface AnomalyResult {
  code: 'under' | 'silent' | 'over' | 'imbalance'
  severity: 'amber' | 'red'
  message: string
}

export interface WeeklyRollup {
  weekStart: string // yyyy-MM-dd (Monday)
  hours: number
  capacity: number
  byType?: Record<string, number>
}

interface Options {
  // If provided, used to compute the "silent" rule; otherwise the rule
  // is skipped (need a last-activity signal).
  lastActivityAt?: string | null
  // Overrides for translation strings — the caller passes i18n-translated
  // messages so this module stays i18n-agnostic.
  labels?: {
    under?: string
    silent?: string
    over?: string
    imbalance?: (dominantType: string) => string
  }
}

const DEFAULT_LABELS = {
  under: 'Under 50% for 2 weeks',
  silent: 'Silent 5+ days',
  over: 'Over 120% — burnout risk',
  imbalance: (t: string) => `Imbalance — ${t} dominates`,
}

export function detectAnomalies(weekly: WeeklyRollup[], opts: Options = {}): AnomalyResult[] {
  const labels = { ...DEFAULT_LABELS, ...(opts.labels ?? {}) }
  const results: AnomalyResult[] = []

  // Rule: under-capacity for 2 consecutive weeks
  const last2 = weekly.slice(-2)
  if (last2.length === 2 && last2.every((w) => w.capacity > 0 && w.hours / w.capacity < 0.5)) {
    results.push({ code: 'under', severity: 'amber', message: labels.under })
  }

  // Rule: over-capacity for 2 consecutive weeks
  if (last2.length === 2 && last2.every((w) => w.capacity > 0 && w.hours / w.capacity > 1.2)) {
    results.push({ code: 'over', severity: 'amber', message: labels.over })
  }

  // Rule: silent — no activity in last 5 business days
  if (opts.lastActivityAt) {
    const last = new Date(opts.lastActivityAt)
    const now = new Date()
    let businessDays = 0
    const cursor = new Date(now)
    while (cursor > last) {
      cursor.setUTCDate(cursor.getUTCDate() - 1)
      const dow = cursor.getUTCDay()
      if (dow !== 0 && dow !== 6) businessDays++
      if (businessDays > 5) break
    }
    if (businessDays >= 5) {
      results.push({ code: 'silent', severity: 'red', message: labels.silent })
    }
  } else if (weekly.length > 0 && weekly.slice(-1)[0]!.hours === 0 && (weekly.slice(-2)[0]?.hours ?? 0) === 0) {
    // Fallback signal when we don't have a last-activity timestamp: two
    // trailing empty weeks is a stand-in for silent.
    results.push({ code: 'silent', severity: 'red', message: labels.silent })
  }

  // Rule: type imbalance — > 80% in one type over last 4 weeks
  const last4 = weekly.slice(-4)
  if (last4.length === 4) {
    const totals: Record<string, number> = {}
    let grand = 0
    for (const w of last4) {
      for (const [type, h] of Object.entries(w.byType ?? {})) {
        totals[type] = (totals[type] ?? 0) + h
        grand += h
      }
    }
    if (grand > 0) {
      const [topType, topHours] = Object.entries(totals).sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
      if (topType && topHours / grand > 0.8) {
        results.push({ code: 'imbalance', severity: 'amber', message: labels.imbalance(topType) })
      }
    }
  }

  return results
}
