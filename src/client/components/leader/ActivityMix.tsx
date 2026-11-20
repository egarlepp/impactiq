import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

// v1.265.0: subtypeName is null for activities with no Subtype picked (most
// teams — Subtypes are opt-in per CLAUDE.md §7). Kept per-row rather than
// re-aggregated separately so a segment's tooltip can break its hours down
// by Subtype without a second request — see tooltipFor below.
interface Row { userId: string; displayName: string; activityTypeName: string; activityTypeColor: string | null; subtypeName: string | null; totalHours: string }

// v1.266.0: same fallback swatches as ActivityBreakdown, used only for a
// type with no admin-set color — the admin-set color (activityTypeColor)
// is what most teams actually see, and is what keeps this chart's segments
// matching Breakdown's bars for the same type.
const FALLBACK_COLORS = [
  '#3b82f6', '#22c55e', '#a855f7', '#f97316', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
]

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; subtypeIds?: string[]; compareMode?: CompareMode }

export function ActivityMix({ teamId, weeksBack, productIds = [], userId, memberIds, subtypeIds, compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorTotal, setPriorTotal] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Row[]>(buildDashboardUrl('activity-mix', { teamId, weeksBack, productIds, userId, memberIds, extra: { subtypeIds: subtypeIds && subtypeIds.length > 0 ? subtypeIds.join(',') : undefined } }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), subtypeIds?.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotal(null); return }
    api.get<Row[]>(buildDashboardUrl('activity-mix', { teamId, weeksBack, productIds, userId, memberIds, extra: { subtypeIds: subtypeIds && subtypeIds.length > 0 ? subtypeIds.join(',') : undefined }, weekShift: weekShiftFor(compareMode) }))
      .then((res) => setPriorTotal((res.data ?? []).reduce((s, r) => s + Number(r.totalHours), 0)))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), subtypeIds?.join(','), compareMode])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />
  if (data.length === 0) return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>

  // Group: userId → { displayName, segments: { typeName: hours }, bySubtype: { typeName: { subtypeName: hours } } }
  const byUser: Record<string, { displayName: string; segments: Record<string, number>; bySubtype: Record<string, Record<string, number>> }> = {}
  const typeOrder: string[] = []
  const typeColor = new Map<string, string>()
  let colorI = 0
  for (const r of data) {
    const h = Number(r.totalHours)
    let bucket = byUser[r.userId]
    if (!bucket) {
      bucket = { displayName: r.displayName, segments: {}, bySubtype: {} }
      byUser[r.userId] = bucket
    }
    bucket.segments[r.activityTypeName] = (bucket.segments[r.activityTypeName] ?? 0) + h
    if (r.subtypeName) {
      const forType = bucket.bySubtype[r.activityTypeName] ?? {}
      forType[r.subtypeName] = (forType[r.subtypeName] ?? 0) + h
      bucket.bySubtype[r.activityTypeName] = forType
    }
    if (!typeOrder.includes(r.activityTypeName)) typeOrder.push(r.activityTypeName)
    if (!typeColor.has(r.activityTypeName)) {
      typeColor.set(r.activityTypeName, r.activityTypeColor ?? FALLBACK_COLORS[colorI % FALLBACK_COLORS.length]!)
      colorI++
    }
  }
  const colorFor = (name: string) => typeColor.get(name) ?? '#6b7280'

  const grandTotal = data.reduce((s, r) => s + Number(r.totalHours), 0)

  // Builds the native tooltip text for one user's type segment: the type
  // total, then an indented line per Subtype if this team/type has any.
  // Falls back to the plain one-line tooltip when there's no Subtype data.
  function tooltipFor(typeName: string, h: number, pct: number, bySubtype: Record<string, Record<string, number>>): string {
    const base = `${typeName}: ${h.toFixed(1)}h (${pct.toFixed(0)}%)`
    const subs = bySubtype[typeName]
    if (!subs) return base
    const lines = Object.entries(subs).sort((a, b) => b[1] - a[1]).map(([subName, subH]) => `  ${subName}: ${subH.toFixed(1)}h`)
    return [base, ...lines].join('\n')
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-700 dark:text-gray-300">
        {typeOrder.map((name) => (
          <span key={name} className="flex items-center gap-1.5">
            <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: colorFor(name) }} />
            {name}
          </span>
        ))}
        {compareMode !== 'off' && priorTotal !== null && (
          <span className="ml-auto flex items-center gap-2"><span>Total: {grandTotal.toFixed(1)}h</span><TrendChip current={grandTotal} prior={priorTotal} mode={compareMode} /></span>
        )}
      </div>
      <div className="grid grid-cols-[180px_1fr] items-center gap-2">
        {Object.entries(byUser).map(([userId, u]) => {
          const total = Object.values(u.segments).reduce((a, b) => a + b, 0)
          return (
            <div key={userId} className="contents">
              <span className="truncate text-xs text-gray-700 dark:text-gray-300">{u.displayName} <span className="text-gray-400">({total.toFixed(1)}h)</span></span>
              <div className="flex h-5 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                {typeOrder.map((name) => {
                  const h = u.segments[name] ?? 0
                  if (h === 0) return null
                  const pct = (h / total) * 100
                  return (
                    <div key={name} style={{ width: `${pct}%`, backgroundColor: colorFor(name) }} title={tooltipFor(name, h, pct, u.bySubtype)} />
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
