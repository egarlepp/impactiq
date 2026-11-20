import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'

interface BreakdownRow {
  userId: string
  displayName: string
  activityTypeName: string
  activityTypeColor: string | null
  activityTypeIcon: string | null
  subtypeName: string | null
  totalHours: string
  activityCount: number
}

interface Props {
  teamId: string
  weeksBack?: number
  productIds?: string[]
  userId?: string | null
  memberIds?: string[]
  subtypeIds?: string[]
  compareMode?: CompareMode
}

// Fallback swatches for activity types with no admin-set color yet — same
// palette as ActivityBreakdown, so the two dashboards read as one system.
const FALLBACK_COLORS = [
  '#3b82f6', '#22c55e', '#a855f7', '#f97316', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
]

// Unique across types even if a Subtype name happens to coincide with
// another type's own name (e.g. a "Discovery" Subtype under some other type).
function keyOf(r: Pick<BreakdownRow, 'activityTypeName' | 'subtypeName'>): string {
  return `${r.activityTypeName}::${r.subtypeName ?? ''}`
}

// v1.269.0: reuses the exact same /breakdown data as ActivityBreakdown, but
// only rows that actually have a Subtype picked ever become their own row
// here — a type with no Subtype usage at all is invisible on this
// dashboard, not shown as a "whole type" row (that's what Activity Type
// Breakdown is for). Every row keeps its PARENT type's color/icon.
//
// Each row's label carries two percentages, both explicitly requested:
//   {count}/{hours}h ({pctOfParentType}%)/{parentTypeTotalHours}h — {pctOfAllSubtypes}%
// — the first is this Subtype's share of its own parent Activity Type's
// TOTAL hours (subtyped + un-subtyped activity of that type combined,
// shown as the trailing "{parentTypeTotalHours}h"); the second (and the
// bar width) is this Subtype's share of the sum of every Subtype row shown
// on this page — the two headline totals (Team Total / each contributor's
// own total) are that same subtyped-only sum, so the numbers reconcile.
export function ActivitySubtypeBreakdown({ teamId, weeksBack = 4, productIds = [], userId, memberIds, subtypeIds, compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<BreakdownRow[]>([])
  const [priorRows, setPriorRows] = useState<BreakdownRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.get<BreakdownRow[]>(buildDashboardUrl('breakdown', { teamId, weeksBack, productIds, userId, memberIds, extra: { subtypeIds: subtypeIds && subtypeIds.length > 0 ? subtypeIds.join(',') : undefined } }))
      .then((res) => { if (res.data) setRows(res.data) })
      .finally(() => setLoading(false))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), subtypeIds?.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorRows([]); return }
    api.get<BreakdownRow[]>(buildDashboardUrl('breakdown', { teamId, weeksBack, productIds, userId, memberIds, extra: { subtypeIds: subtypeIds && subtypeIds.length > 0 ? subtypeIds.join(',') : undefined }, weekShift: weekShiftFor(compareMode) }))
      .then((res) => setPriorRows(res.data ?? []))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), subtypeIds?.join(','), compareMode])

  // Color/icon per PARENT Activity Type — same convention as ActivityBreakdown.
  const typeColor = useMemo(() => {
    const map = new Map<string, string>()
    let i = 0
    for (const r of rows) {
      if (map.has(r.activityTypeName)) continue
      map.set(r.activityTypeName, r.activityTypeColor ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!)
      i++
    }
    return map
  }, [rows])
  const typeIcon = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const r of rows) {
      if (!map.has(r.activityTypeName)) map.set(r.activityTypeName, r.activityTypeIcon)
    }
    return map
  }, [rows])

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  // Each parent Activity Type's TOTAL hours team-wide, across ALL of its
  // activity — subtyped or not. This is the denominator for the first
  // (parenthetical) percentage and the "{parentTypeTotalHours}h" figure;
  // it is NOT the same as the subtyped-only totals below.
  const typeTotalHours = new Map<string, number>()
  for (const row of rows) {
    typeTotalHours.set(row.activityTypeName, (typeTotalHours.get(row.activityTypeName) ?? 0) + Number(row.totalHours))
  }

  // Aggregate by Subtype-key across team — only rows with a Subtype picked.
  const subtypeMap = new Map<string, { label: string; typeName: string; hours: number; count: number }>()
  for (const row of rows) {
    if (!row.subtypeName) continue
    const key = keyOf(row)
    const entry = subtypeMap.get(key) ?? { label: row.subtypeName, typeName: row.activityTypeName, hours: 0, count: 0 }
    entry.hours += Number(row.totalHours)
    entry.count += Number(row.activityCount)
    subtypeMap.set(key, entry)
  }
  const subtypeRows = [...subtypeMap.entries()].sort((a, b) => b[1].hours - a[1].hours)
  const totalHours = subtypeRows.reduce((s, [, v]) => s + v.hours, 0)
  const totalCount = subtypeRows.reduce((s, [, v]) => s + v.count, 0)
  const priorTotal = priorRows.reduce((s, r) => s + (r.subtypeName ? Number(r.totalHours) : 0), 0)

  // Per-contributor: same Subtype-key grouping, plus that contributor's OWN
  // per-type totals (never the team-wide figure) for the parenthetical %.
  const contribMap = new Map<string, {
    name: string
    bySubtype: Map<string, { label: string; typeName: string; hours: number; count: number }>
    typeTotalHours: Map<string, number>
    total: number
    totalCount: number
  }>()
  for (const row of rows) {
    if (!contribMap.has(row.userId)) contribMap.set(row.userId, { name: row.displayName, bySubtype: new Map(), typeTotalHours: new Map(), total: 0, totalCount: 0 })
    const c = contribMap.get(row.userId)!
    const h = Number(row.totalHours)
    const n = Number(row.activityCount)
    c.typeTotalHours.set(row.activityTypeName, (c.typeTotalHours.get(row.activityTypeName) ?? 0) + h)
    if (row.subtypeName) {
      const key = keyOf(row)
      const entry = c.bySubtype.get(key) ?? { label: row.subtypeName, typeName: row.activityTypeName, hours: 0, count: 0 }
      entry.hours += h
      entry.count += n
      c.bySubtype.set(key, entry)
      c.total += h
      c.totalCount += n
    }
  }
  const priorByUser = new Map<string, number>()
  for (const row of priorRows) {
    if (!row.subtypeName) continue
    priorByUser.set(row.userId, (priorByUser.get(row.userId) ?? 0) + Number(row.totalHours))
  }
  const contributors = [...contribMap.entries()].filter(([, c]) => c.bySubtype.size > 0).sort((a, b) => b[1].total - a[1].total)

  // Distinct parent Activity Types actually represented among the Subtype
  // rows shown — the legend so a reader can tell what each bar's color/icon
  // belongs to without already knowing the team's Activity Type palette.
  const legendTypeNames = Array.from(new Set(subtypeRows.map(([, v]) => v.typeName)))

  if (subtypeRows.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>
  }

  // "{count}/{hours}h ({pctOfParentType}%)/{parentTypeTotalHours}h — {pctOfWhole}%"
  function fmtRow(hours: number, count: number, parentTotal: number, whole: number): string {
    const pctOfParent = parentTotal > 0 ? Math.round((hours / parentTotal) * 100) : 0
    const pctOfWhole = whole > 0 ? Math.round((hours / whole) * 100) : 0
    return `${count}/${hours.toFixed(1)}h (${pctOfParent}%)/${parentTotal.toFixed(1)}h — ${pctOfWhole}%`
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('leader.subtype_breakdown.description', 'Activity Type Breakdown broken down one level further, by Subtype. Each bar keeps its parent Activity Type’s color and icon.')}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-700 dark:text-gray-300">
        {legendTypeNames.map((name) => {
          const color = typeColor.get(name) ?? '#3b82f6'
          const icon = typeIcon.get(name)
          return (
            <span key={name} className="flex items-center gap-1.5">
              {icon && <DynamicIcon name={icon} className="h-3.5 w-3.5 shrink-0" style={{ color }} />}
              {name}
            </span>
          )
        })}
      </div>
      <div className="flex flex-col gap-6">
        {/* Team aggregate */}
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t('leader.subtype_breakdown.team_total', 'Team Total')}
            </p>
            <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <span>{totalCount}/{totalHours.toFixed(1)}h</span>
              {compareMode !== 'off' && (
                <TrendChip current={totalHours} prior={priorTotal} mode={compareMode} />
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {subtypeRows.map(([key, v]) => {
              const color = typeColor.get(v.typeName) ?? '#3b82f6'
              const icon = typeIcon.get(v.typeName)
              const parentTotal = typeTotalHours.get(v.typeName) ?? 0
              const pctOfWhole = totalHours > 0 ? (v.hours / totalHours) * 100 : 0
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="flex w-44 shrink-0 items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                    {icon && <DynamicIcon name={icon} className="h-3.5 w-3.5 shrink-0" style={{ color }} />}
                    <span className="truncate">{v.label}</span>
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pctOfWhole}%`, backgroundColor: color }}
                    />
                  </div>
                  <span className="w-48 shrink-0 text-right font-mono text-xs text-gray-600 dark:text-gray-400">
                    {fmtRow(v.hours, v.count, parentTotal, totalHours)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Per contributor — 3-column grid, each cell shows the member's own compare chip */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {contributors.map(([uid, { name, bySubtype, typeTotalHours: contribTypeTotalHours, total, totalCount: contribTotalCount }]) => {
            const prior = priorByUser.get(uid) ?? 0
            return (
              <div key={uid} className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-semibold text-gray-800 dark:text-gray-200">{name}</p>
                  <div className="flex shrink-0 items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                    <span>{contribTotalCount}/{total.toFixed(1)}h</span>
                    {compareMode !== 'off' && (
                      <TrendChip current={total} prior={prior} mode={compareMode} />
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {[...bySubtype.entries()].sort((a, b) => b[1].hours - a[1].hours).map(([key, v]) => {
                    const color = typeColor.get(v.typeName) ?? '#3b82f6'
                    const icon = typeIcon.get(v.typeName)
                    const parentTotal = contribTypeTotalHours.get(v.typeName) ?? 0
                    const pctOfWhole = total > 0 ? (v.hours / total) * 100 : 0
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <span className="flex w-28 shrink-0 items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400">
                          {icon && <DynamicIcon name={icon} className="h-3 w-3 shrink-0" style={{ color }} />}
                          <span className="truncate">{v.label}</span>
                        </span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${pctOfWhole}%`, backgroundColor: color, opacity: 0.85 }}
                          />
                        </div>
                        <span className="w-44 shrink-0 text-right font-mono text-[11px] text-gray-500 dark:text-gray-400">
                          {fmtRow(v.hours, v.count, parentTotal, total)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
