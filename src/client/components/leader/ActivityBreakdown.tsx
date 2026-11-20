import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
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
  // v1.265.0: Subtype dimension (PRD §7/Batch 6) — null for activities with
  // no Subtype picked, which is most teams (Subtypes are opt-in per
  // CLAUDE.md §7). See the Team Total section below for how this renders.
  subtypeName: string | null
  totalHours: string
  activityCount: number
}

interface ActivityBreakdownProps {
  teamId: string
  weeksBack?: number
  productIds?: string[]
  userId?: string | null
  memberIds?: string[]
  subtypeIds?: string[]
  compareMode?: CompareMode
}

// Fallback swatches for activity types with no admin-set color yet.
const FALLBACK_COLORS = [
  '#3b82f6', '#22c55e', '#a855f7', '#f97316', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
]

export function ActivityBreakdown({ teamId, weeksBack = 4, productIds = [], userId, memberIds, subtypeIds, compareMode = 'off' }: ActivityBreakdownProps) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<BreakdownRow[]>([])
  const [priorRows, setPriorRows] = useState<BreakdownRow[]>([])
  const [loading, setLoading] = useState(true)
  // Which Team-Total type rows have their Subtype breakdown expanded.
  // Empty = fully collapsed (default) — only types with actual Subtype
  // data get a chevron at all (see typeSubtypeMap below).
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set())
  // Same idea, per contributor card — keyed by `${uid}::${typeName}` since
  // the same type name can be expanded independently for different people.
  const [expandedContribTypes, setExpandedContribTypes] = useState<Set<string>>(new Set())

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

  // Assign a stable color per activity type: prefer the admin-set color from
  // the DB, fall back to a palette slot keyed by first-seen order so the bar
  // and the icon share the same swatch.
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

  // Aggregate by type across team
  const typeMap = new Map<string, { hours: number; count: number }>()
  for (const row of rows) {
    const entry = typeMap.get(row.activityTypeName) ?? { hours: 0, count: 0 }
    entry.hours += Number(row.totalHours)
    entry.count += Number(row.activityCount)
    typeMap.set(row.activityTypeName, entry)
  }
  const types = [...typeMap.entries()].sort((a, b) => b[1].hours - a[1].hours)
  const totalHours = types.reduce((s, [, v]) => s + v.hours, 0)
  const totalCount = types.reduce((s, [, v]) => s + v.count, 0)
  const priorTotal = priorRows.reduce((s, r) => s + Number(r.totalHours), 0)

  // Subtype breakdown per type, team-wide. Only rows with a Subtype picked
  // contribute here — a type with none (the common case, since Subtypes are
  // opt-in per team) gets no entry at all, so no chevron renders for it.
  const typeSubtypeMap = new Map<string, Map<string, { hours: number; count: number }>>()
  for (const row of rows) {
    if (!row.subtypeName) continue
    const bySubtype = typeSubtypeMap.get(row.activityTypeName) ?? new Map<string, { hours: number; count: number }>()
    const entry = bySubtype.get(row.subtypeName) ?? { hours: 0, count: 0 }
    entry.hours += Number(row.totalHours)
    entry.count += Number(row.activityCount)
    bySubtype.set(row.subtypeName, entry)
    typeSubtypeMap.set(row.activityTypeName, bySubtype)
  }

  function toggleType(name: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  function toggleContribType(key: string) {
    setExpandedContribTypes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Per-contributor aggregation with prior-period lookup for the per-member
  // chip. bySubtype mirrors typeSubtypeMap above but scoped to this one
  // contributor — same "only rows with a Subtype picked contribute" rule.
  const contribMap = new Map<string, { name: string; byType: Map<string, { hours: number; count: number; bySubtype: Map<string, { hours: number; count: number }> }>; total: number; totalCount: number }>()
  for (const row of rows) {
    if (!contribMap.has(row.userId)) contribMap.set(row.userId, { name: row.displayName, byType: new Map(), total: 0, totalCount: 0 })
    const c = contribMap.get(row.userId)!
    const h = Number(row.totalHours)
    const n = Number(row.activityCount)
    const entry = c.byType.get(row.activityTypeName) ?? { hours: 0, count: 0, bySubtype: new Map<string, { hours: number; count: number }>() }
    entry.hours += h
    entry.count += n
    if (row.subtypeName) {
      const subEntry = entry.bySubtype.get(row.subtypeName) ?? { hours: 0, count: 0 }
      subEntry.hours += h
      subEntry.count += n
      entry.bySubtype.set(row.subtypeName, subEntry)
    }
    c.byType.set(row.activityTypeName, entry)
    c.total += h
    c.totalCount += n
  }
  const priorByUser = new Map<string, number>()
  for (const row of priorRows) {
    priorByUser.set(row.userId, (priorByUser.get(row.userId) ?? 0) + Number(row.totalHours))
  }
  const contributors = [...contribMap.entries()].sort((a, b) => b[1].total - a[1].total)

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>
  }

  return (
    <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-6">
          {/* Team aggregate */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('leader.subtype_breakdown.team_total', 'Team Total')}</p>
              <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                <span>{totalCount}/{totalHours.toFixed(1)}h</span>
                {compareMode !== 'off' && (
                  <TrendChip current={totalHours} prior={priorTotal} mode={compareMode} />
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {types.map(([name, v]) => {
                const color = typeColor.get(name) ?? '#3b82f6'
                const icon = typeIcon.get(name)
                const pct = totalHours > 0 ? Math.round((v.hours / totalHours) * 100) : 0
                const bySubtype = typeSubtypeMap.get(name)
                const hasSubtypes = !!bySubtype && bySubtype.size > 0
                const open = expandedTypes.has(name)
                const subtypeEntries = bySubtype ? [...bySubtype.entries()].sort((a, b) => b[1].hours - a[1].hours) : []
                return (
                  <div key={name}>
                    <div className="flex items-center gap-3">
                      {hasSubtypes ? (
                        <button
                          type="button"
                          onClick={() => toggleType(name)}
                          aria-label={open ? t('leader.team_activity_deep_dive.collapse_row', 'Collapse') : t('leader.team_activity_deep_dive.expand_row', 'Expand')}
                          aria-expanded={open}
                          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="inline-block h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="flex w-36 shrink-0 items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                        {icon && <DynamicIcon name={icon} className="h-3.5 w-3.5 shrink-0" style={{ color }} />}
                        <span className="truncate">{name}</span>
                      </span>
                      <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${(v.hours / totalHours) * 100}%`, backgroundColor: color }}
                        />
                      </div>
                      <span className="w-28 shrink-0 text-right font-mono text-xs text-gray-600 dark:text-gray-400">
                        {v.count}/{v.hours.toFixed(1)}h — {pct}%
                      </span>
                    </div>
                    {open && subtypeEntries.length > 0 && (
                      <div className="ml-[1.625rem] mt-1 flex flex-col gap-1">
                        {subtypeEntries.map(([subName, sv]) => {
                          const subPct = v.hours > 0 ? Math.round((sv.hours / v.hours) * 100) : 0
                          return (
                            <div key={subName} className="flex items-center gap-3">
                              <span className="flex w-36 shrink-0 truncate pl-0.5 text-[11px] text-gray-500 dark:text-gray-400">{subName}</span>
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                                <div
                                  className="h-full rounded-full"
                                  style={{ width: `${(sv.hours / v.hours) * 100}%`, backgroundColor: color, opacity: 0.6 }}
                                />
                              </div>
                              <span className="w-28 shrink-0 text-right font-mono text-[11px] text-gray-400 dark:text-gray-500">
                                {sv.count}/{sv.hours.toFixed(1)}h — {subPct}%
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Per contributor — 3-column grid, each cell shows the member's own compare chip */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {contributors.map(([uid, { name, byType, total, totalCount }]) => {
              const prior = priorByUser.get(uid) ?? 0
              return (
                <div key={uid} className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold text-gray-800 dark:text-gray-200">{name}</p>
                    <div className="flex shrink-0 items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                      <span>{totalCount}/{total.toFixed(1)}h</span>
                      {compareMode !== 'off' && (
                        <TrendChip current={total} prior={prior} mode={compareMode} />
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    {[...byType.entries()].sort((a, b) => b[1].hours - a[1].hours).map(([typeName, v]) => {
                      const color = typeColor.get(typeName) ?? '#3b82f6'
                      const icon = typeIcon.get(typeName)
                      const pct = total > 0 ? Math.round((v.hours / total) * 100) : 0
                      const contribKey = `${uid}::${typeName}`
                      const hasSubtypes = v.bySubtype.size > 0
                      const contribOpen = expandedContribTypes.has(contribKey)
                      const contribSubtypeEntries = hasSubtypes ? [...v.bySubtype.entries()].sort((a, b) => b[1].hours - a[1].hours) : []
                      return (
                        <div key={typeName}>
                          <div className="flex items-center gap-2">
                            {hasSubtypes ? (
                              <button
                                type="button"
                                onClick={() => toggleContribType(contribKey)}
                                aria-label={contribOpen ? t('leader.team_activity_deep_dive.collapse_row', 'Collapse') : t('leader.team_activity_deep_dive.expand_row', 'Expand')}
                                aria-expanded={contribOpen}
                                className="flex h-3 w-3 shrink-0 items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                              >
                                {contribOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              </button>
                            ) : (
                              <span className="inline-block h-3 w-3 shrink-0" />
                            )}
                            <span className="flex w-20 shrink-0 items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400">
                              {icon && <DynamicIcon name={icon} className="h-3 w-3 shrink-0" style={{ color }} />}
                              <span className="truncate">{typeName}</span>
                            </span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${(v.hours / total) * 100}%`, backgroundColor: color, opacity: 0.85 }}
                              />
                            </div>
                            <span className="w-24 shrink-0 text-right font-mono text-[11px] text-gray-500 dark:text-gray-400">
                              {v.count}/{v.hours.toFixed(1)}h — {pct}%
                            </span>
                          </div>
                          {contribOpen && contribSubtypeEntries.length > 0 && (
                            <div className="ml-[1.25rem] mt-0.5 flex flex-col gap-0.5">
                              {contribSubtypeEntries.map(([subName, sv]) => {
                                const subPct = v.hours > 0 ? Math.round((sv.hours / v.hours) * 100) : 0
                                return (
                                  <div key={subName} className="flex items-center gap-2">
                                    <span className="flex w-20 shrink-0 truncate pl-0.5 text-[10px] text-gray-400 dark:text-gray-500">{subName}</span>
                                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-gray-50 dark:bg-gray-900">
                                      <div
                                        className="h-full rounded-full"
                                        style={{ width: `${(sv.hours / v.hours) * 100}%`, backgroundColor: color, opacity: 0.5 }}
                                      />
                                    </div>
                                    <span className="w-24 shrink-0 text-right font-mono text-[10px] text-gray-400 dark:text-gray-500">
                                      {sv.count}/{sv.hours.toFixed(1)}h — {subPct}%
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
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
