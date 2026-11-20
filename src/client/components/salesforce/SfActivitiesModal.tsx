import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { X, Clock, User, Building2, Briefcase, Megaphone, UserPlus, ChevronDown, ChevronRight, Layers, Target, History, Link2, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { api } from '../../lib/api.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useCrmLabelContext, useCrmProvider } from '../../store/crmProvider.js'
import { formatTimeInTZ } from '../../lib/tz.js'
import { SfRelationshipHelp } from './SfRelationshipHelp.js'
import { cn } from '../../lib/utils.js'
import { evalTypeIcon } from '../../lib/sf-icons.js'
import { EvalFieldsPanel } from '../activities/EvalFieldsPanel.js'
import { CriteriaIqProjectBox } from '../activities/CriteriaIqProjectPicker.js'
import { isCriteriaIqProjectLink } from '../../../shared/evaluationSource.js'
import { SfHistoricalSection, buildHistoryUrl, type HistoricalMeta } from './SfHistoricalSection.js'
import { SfSearch, type SfSelection } from './SfSearch.js'

interface SfActivity {
  id: string
  title: string
  startDatetime: string
  effortHours: string
  notes: string | null
  crmWhatId: string
  crmWhatType: 'Opportunity' | 'Account' | 'Campaign'
  crmWhatName: string
  activityTypeName: string
  activityTypeColor: string | null
  activityTypeIcon: string | null
  userId: string
  userDisplayName: string
  userEmail: string
}

interface SfActivitiesModalProps {
  open: boolean
  onClose: () => void
  teamId: string
  whatId: string
  whatType: 'Opportunity' | 'Account' | 'Related'
  whatName: string
  // Optional dashboard-scoped date range. When present, the modal
  // renders a Filtered / All Data toggle and defaults to Filtered so
  // the numbers match the report the user drilled in from.
  rangeStart?: string
  rangeEnd?: string
  // Additional whatIds to include alongside `whatId` (e.g. Opportunity
  // ids under an Account) so the drawer aggregates the same rolled-up
  // set the parent dashboard already summed.
  extraWhatIds?: string[]
  // v1.68.0: when set, the modal filters activities via crm_related_id
  // (child-object drill-down for extras like Evaluation__c). In that
  // mode whatId is used as the display anchor only; the API query
  // switches to the relatedId param.
  relatedId?: string
  // v1.148.0: SF object API name of the related record (e.g.
  // "Evaluations__c"). Drives the editable Project Fields panel.
  relatedType?: string | null
  // v1.74.0: friendly type label override — used by the SF Related
  // chip so the header reads e.g. "Evaluations" (admin's Display
  // Label) instead of the raw "Related" whatType tag.
  whatTypeLabel?: string
  // vNext: called after a successful Opportunity Relink so a caller like
  // AccountBurn.tsx can refresh its own row for the old Opp (its hours/
  // count for that Opp id just dropped to zero).
  onRelinked?: () => void
}

export function SfActivitiesModal({ open, onClose, teamId, whatId, whatType, whatName, rangeStart, rangeEnd, extraWhatIds, relatedId, relatedType, whatTypeLabel, onRelinked }: SfActivitiesModalProps) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const { user: tzUser } = useCurrentUser()
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [rows, setRows] = useState<SfActivity[]>([])
  const [totalHours, setTotalHours] = useState(0)
  const [loading, setLoading] = useState(false)
  const hasRange = !!(rangeStart && rangeEnd)
  const [mode, setMode] = useState<'filtered' | 'all'>('filtered')
  // v1.122.0: Account drill-down now supports a Direct / Include All
  // toggle. Direct = activities logged against this Account only.
  // Include All = Direct + Opps under this Account + Campaigns tied to
  // those Opps + Leads that converted to this Account. See
  // SfRelationshipHelp for the definitions the user sees.
  const isAccount = whatType === 'Account' && !relatedId
  const [scope, setScope] = useState<'direct' | 'include_all'>('direct')
  const [breakdown, setBreakdown] = useState<Array<{ type: 'Account' | 'Opportunity' | 'Campaign' | 'Lead'; count: number; hours: number }>>([])
  // v1.148.0: lightweight local-snapshot read (no live SF call) just for
  // the header icon — EvalFieldsPanel below does its own fuller fetch.
  const [evalData, setEvalData] = useState<{ crmEvalType: string | null } | null>(null)
  useEffect(() => {
    if (!open || !relatedId) { setEvalData(null); return }
    let cancelled = false
    void api.get<{ crmEvalType: string | null }>(`/api/activities/eval-fields?teamId=${teamId}&relatedId=${relatedId}`).then((res) => {
      if (!cancelled) setEvalData(res.data ?? null)
    })
    return () => { cancelled = true }
  }, [open, teamId, relatedId])

  useEffect(() => {
    if (!open) return
    // Reset to Filtered every time the modal reopens so drilling into
    // a new row doesn't inherit the previous drawer's toggle state.
    setMode('filtered')
    setScope('direct')
    setBreakdown([])
    setRelinkPanelOpen(false)
    setRelinkTarget(null)
    setRelinkError(null)
    setRelinkResult(null)
  }, [open, whatId])

  // vNext: Opportunity Relink (CLAUDE.md §7). See §2.5 of the plan — a
  // bulk data CORRECTION, gated leader/team_admin/admin on this specific
  // team or App Admin. This is a UI-only convenience gate; the real
  // enforcement is server-side (requireRole on POST /relink-opportunity).
  // Relink reads the target live (the Salesforce admin connection, or the
  // HubSpot portal connection), so it needs a CRM.
  const crmProvider = useCrmProvider()
  const canRelink = (crmProvider === 'salesforce' || crmProvider === 'hubspot') && !!tzUser && (
    tzUser.isAppAdmin
    || tzUser.memberships.some((m) => m.teamId === teamId && (m.role === 'leader' || m.role === 'team_admin' || m.role === 'admin'))
  )
  const [relinkPanelOpen, setRelinkPanelOpen] = useState(false)
  const [relinkTarget, setRelinkTarget] = useState<SfSelection | null>(null)
  const [relinking, setRelinking] = useState(false)
  const [relinkError, setRelinkError] = useState<string | null>(null)
  const [relinkResult, setRelinkResult] = useState<{ activitiesUpdated: number; requeuedForSync: number; toOppName: string } | null>(null)

  async function confirmRelink() {
    if (!relinkTarget || relinkTarget.type !== 'Opportunity') return
    const ok = window.confirm(
      t('sf_activities.relink_confirm', {
        defaultValue: 'Relink all {{count}} ImpactIQ activities from "{{fromName}}" to "{{toName}}"? This also pushes the corrected link to the matching Salesforce Events/Tasks. This cannot be undone automatically.',
        count: rows.length,
        fromName: whatName,
        toName: relinkTarget.name,
        context: crmCtx,
      }),
    )
    if (!ok) return
    setRelinking(true)
    setRelinkError(null)
    const res = await api.post<{ activitiesUpdated: number; requeuedForSync: number; toOpp: { id: string; name: string } }>('/api/activities/relink-opportunity', {
      teamId,
      fromOppId: whatId,
      toOppId: relinkTarget.id,
    })
    setRelinking(false)
    if (res.error || !res.data) {
      // Reuse the exact same role-aware "no admin SF connection" copy the
      // manual "Refresh from Salesforce" button already uses, rather than
      // duplicating a translated string for the identical situation.
      if (res.error === 'no_admin_sf_connection') {
        setRelinkError(tzUser?.isAppAdmin
          ? t('leader.refresh_no_sf_connection_admin', 'Refresh failed: no admin Salesforce connection is configured. Go to Admin → Integrations to connect one.')
          : t('leader.refresh_no_sf_connection', 'Refresh failed: no admin Salesforce connection is configured. Contact your App Admin to connect one under Admin → Integrations.'))
      } else {
        setRelinkError(res.error ?? t('errors.activities.relink_failed'))
      }
      return
    }
    setRelinkResult({ activitiesUpdated: res.data.activitiesUpdated, requeuedForSync: res.data.requeuedForSync, toOppName: res.data.toOpp.name })
    setRelinkPanelOpen(false)
    setRelinkTarget(null)
    setRefreshNonce((n) => n + 1)
    onRelinked?.()
  }

  const extraKey = extraWhatIds ? extraWhatIds.join(',') : ''
  useEffect(() => {
    if (!open) return
    setLoading(true)
    const params = new URLSearchParams({ teamId })
    if (hasRange && mode === 'filtered') {
      params.set('startDate', rangeStart!.slice(0, 10))
      params.set('endDate', rangeEnd!.slice(0, 10))
    }
    // v1.122.0: Account rows hit the dedicated account-drill endpoint
    // that supports Direct / Include All. Every other whatType stays
    // on the original /by-sf path.
    const url = (() => {
      if (isAccount) {
        params.set('accountId', whatId)
        params.set('mode', scope)
        return `/api/activities/account-drill?${params.toString()}`
      }
      if (relatedId) {
        params.set('relatedId', relatedId)
      } else {
        params.set('whatId', whatId)
        if (extraWhatIds && extraWhatIds.length > 0) {
          params.set('whatIds', extraWhatIds.join(','))
        }
      }
      return `/api/activities/by-sf?${params.toString()}`
    })()
    api
      .get<SfActivity[]>(url)
      .then((res) => {
        setRows(res.data ?? [])
        const meta = res.meta as { totalHours?: number; breakdown?: Array<{ type: 'Account' | 'Opportunity' | 'Campaign' | 'Lead'; count: number; hours: number }> }
        setTotalHours(meta?.totalHours ?? 0)
        setBreakdown(meta?.breakdown ?? [])
        setLoading(false)
      })
  }, [open, teamId, whatId, hasRange, mode, rangeStart, rangeEnd, extraKey, relatedId, isAccount, scope, refreshNonce])

  // v1.214.0: pre-ImpactIQ Salesforce history for this record.
  //
  // Kept in its own state and its own fetch — `histMeta.estimatedHours` is an
  // ESTIMATE from SF scheduled meeting length and must never be folded into
  // `totalHours` above, which is logged effort. The header renders them as two
  // separate clauses for exactly that reason.
  //
  // The probe below is countOnly, so a record with no history costs one cheap
  // aggregate query and renders nothing. Rows are fetched only on expand.
  const [histMeta, setHistMeta] = useState<HistoricalMeta | null>(null)
  const histBase = useMemo(() => {
    if (!open || relatedId) return null
    return {
      teamId,
      whatId,
      isAccount,
      scope,
      extraWhatIds,
      ...(hasRange && mode === 'filtered'
        ? { startDate: rangeStart!.slice(0, 10), endDate: rangeEnd!.slice(0, 10) }
        : {}),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, teamId, whatId, isAccount, scope, extraKey, hasRange, mode, rangeStart, rangeEnd, relatedId])

  useEffect(() => {
    if (!histBase) { setHistMeta(null); return }
    let cancelled = false
    void api
      .get<unknown[]>(buildHistoryUrl({ ...histBase, countOnly: true }))
      .then((res) => {
        if (!cancelled) setHistMeta((res.meta as unknown as HistoricalMeta) ?? null)
      })
      .catch(() => {
        // History is additive context — a failure here must never break the
        // modal's primary content.
        if (!cancelled) setHistMeta(null)
      })
    return () => { cancelled = true }
  }, [histBase])

  // Per-contributor breakdown.
  const byUserList = useMemo(() => {
    const byUser = new Map<string, { name: string; email: string; count: number; hours: number }>()
    for (const r of rows) {
      const entry = byUser.get(r.userId) ?? { name: r.userDisplayName, email: r.userEmail, count: 0, hours: 0 }
      entry.count++
      entry.hours += Number(r.effortHours)
      byUser.set(r.userId, entry)
    }
    return Array.from(byUser.values()).sort((a, b) => b.hours - a.hours)
  }, [rows])

  // Per-type breakdown (with color + icon).
  const byTypeList = useMemo(() => {
    const byType = new Map<string, { count: number; hours: number; color: string | null; icon: string | null }>()
    for (const r of rows) {
      const entry = byType.get(r.activityTypeName) ?? { count: 0, hours: 0, color: r.activityTypeColor, icon: r.activityTypeIcon }
      entry.count++
      entry.hours += Number(r.effortHours)
      byType.set(r.activityTypeName, entry)
    }
    return Array.from(byType.entries()).sort((a, b) => b[1].hours - a[1].hours)
  }, [rows])

  // Group activities by Year → Month → Day for the accordion timeline. Newest
  // year and its newest month/day expand by default; older buckets collapse.
  const grouped = useMemo(() => {
    const sorted = [...rows].sort((a, b) => new Date(b.startDatetime).getTime() - new Date(a.startDatetime).getTime())
    const years = new Map<string, Map<string, Map<string, SfActivity[]>>>()
    for (const r of sorted) {
      const d = new Date(r.startDatetime)
      const yk = String(d.getFullYear())
      const mk = format(d, 'MMMM yyyy')
      const dk = format(d, 'EEEE, MMM d')
      if (!years.has(yk)) years.set(yk, new Map())
      const ym = years.get(yk)!
      if (!ym.has(mk)) ym.set(mk, new Map())
      const md = ym.get(mk)!
      if (!md.has(dk)) md.set(dk, [])
      md.get(dk)!.push(r)
    }
    return years
  }, [rows])

  // Track expanded state per year/month/day key. Only the very newest
  // year > month > day is expanded on mount; everything else collapses.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    const initial = new Set<string>()
    const firstYear = grouped.keys().next().value as string | undefined
    if (firstYear) {
      initial.add(`y:${firstYear}`)
      const months = grouped.get(firstYear)!
      const firstMonth = months.keys().next().value as string | undefined
      if (firstMonth) {
        initial.add(`m:${firstYear}:${firstMonth}`)
        const days = months.get(firstMonth)!
        const firstDay = days.keys().next().value as string | undefined
        if (firstDay) initial.add(`d:${firstYear}:${firstMonth}:${firstDay}`)
      }
    }
    setExpanded(initial)
  }, [grouped])

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!open) return null
  // v1.148.0: for the Related (Project/Evaluation) drill-in, use the
  // type-specific icon once known — falls back to Target (matches the
  // ActivityCard chip / ProjectMatchChip default).
  const Icon = whatType === 'Opportunity' ? Briefcase
    : whatType === 'Related' ? (evalTypeIcon(evalData?.crmEvalType) ?? Target)
    : Building2

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      // v1.74.3: swallow the click after invoking onClose so the
      // backdrop-close doesn't bubble up to the underlying activity
      // card and open its Edit drawer.
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-blue-100 p-2 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {whatTypeLabel ?? t(`sf.${whatType.toLowerCase()}`, whatType)}
              </p>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {whatName}
              </h2>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {rows.length} {t('sf_activities.activities')} · {totalHours.toFixed(1)}h {t('sf_activities.total')}
                {/* Historical is a SEPARATE clause, never summed into
                    totalHours above — one is logged effort, the other an
                    estimate from SF scheduled meeting length. */}
                {!!histMeta?.count && (
                  <span className="ml-1 text-amber-700 dark:text-amber-400">
                    {' · '}
                    <History className="mb-0.5 inline h-3 w-3" />{' '}
                    {t('sf_activities.historical_count', {
                      count: histMeta.count,
                      hours: histMeta.estimatedHours.toFixed(1),
                    })}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            {isAccount && (
              <>
                <SfRelationshipHelp className="mt-1" />
                <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-900">
                  <button
                    type="button"
                    onClick={() => setScope('direct')}
                    className={cn(
                      'flex items-center gap-1 rounded px-2 py-0.5',
                      scope === 'direct' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300',
                    )}
                    title={t('sf_activities.scope_direct_hint', 'Only activities logged directly against this account. Activities on its opportunities are excluded.')}
                  >
                    <Building2 className="h-3 w-3" />
                    {t('sf_activities.scope_direct', 'Direct')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setScope('include_all')}
                    className={cn(
                      'flex items-center gap-1 rounded px-2 py-0.5',
                      scope === 'include_all' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300',
                    )}
                    title={t('sf_activities.scope_include_all_hint', { context: crmCtx })}
                  >
                    <Layers className="h-3 w-3" />
                    {t('sf_activities.scope_include_all', 'Include All')}
                  </button>
                </div>
              </>
            )}
            {hasRange && (
              <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-900">
                <button
                  type="button"
                  onClick={() => setMode('filtered')}
                  className={mode === 'filtered'
                    ? 'rounded bg-blue-600 px-2 py-0.5 font-medium text-white'
                    : 'rounded px-2 py-0.5 text-gray-600 dark:text-gray-300'}
                  title={t('sf_activities.range_filtered_hint', 'Only activities in the dashboard date range')}
                >
                  {t('sf_activities.range_filtered', 'Filtered')}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('all')}
                  className={mode === 'all'
                    ? 'rounded bg-blue-600 px-2 py-0.5 font-medium text-white'
                    : 'rounded px-2 py-0.5 text-gray-600 dark:text-gray-300'}
                  title={t('sf_activities.range_all_hint', 'All activities ever logged against this record')}
                >
                  {t('sf_activities.range_all', 'All time')}
                </button>
              </div>
            )}
            {/* vNext: Opportunity Relink (CLAUDE.md §7) — moves every
                ImpactIQ activity on this Opportunity to a different one,
                e.g. after a rep closes it Lost/Duplicate because the deal
                moved to a renewal. leader/team_admin/admin (or App Admin)
                only; never shown for Account/Related drill-ins. */}
            {whatType === 'Opportunity' && canRelink && (
              <button
                type="button"
                onClick={() => setRelinkPanelOpen((v) => !v)}
                className={cn(
                  'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium',
                  relinkPanelOpen
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800',
                )}
                title={t('sf_activities.relink_button_hint', { defaultValue: 'Move every ImpactIQ activity on this Opportunity to a different one', context: crmCtx })}
              >
                <Link2 className="h-3.5 w-3.5" />
                {t('sf_activities.relink_button', 'Relink')}
              </button>
            )}
            <button onClick={onClose} className="rounded p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Relink panel — see CLAUDE.md §7. Deliberately inline, not a
            second modal, so this stays the ONE Relink UI in the app: the
            "Closed Lost — Needs Review" dashboard's own Relink action just
            opens this same modal. */}
        {relinkPanelOpen && (
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-gray-800/50">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t('sf_activities.relink_panel_title', { defaultValue: 'Relink to a different Opportunity', context: crmCtx })}
            </p>
            <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
              {t('sf_activities.relink_pick_target_hint', { defaultValue: 'Search for the Opportunity these activities should move to. This also pushes the corrected link to any matching Salesforce Events/Tasks.', context: crmCtx })}
            </p>
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <SfSearch
                  value={relinkTarget}
                  onChange={(sel) => setRelinkTarget(sel)}
                  disabled={relinking}
                  showClosed
                />
              </div>
              <button
                type="button"
                onClick={() => void confirmRelink()}
                disabled={!relinkTarget || relinkTarget.type !== 'Opportunity' || relinking}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
              >
                {relinking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                {t('sf_activities.relink_confirm_button', 'Relink')}
              </button>
            </div>
            {relinkError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {relinkError}
              </p>
            )}
          </div>
        )}
        {relinkResult && (
          <div className="border-b border-gray-200 bg-emerald-50 px-6 py-3 text-xs text-emerald-800 dark:border-gray-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <p className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              {t('sf_activities.relink_success_toast', {
                defaultValue: 'Moved {{activitiesUpdated}} activities to "{{toOppName}}" — {{requeuedForSync}} pushed to Salesforce for sync.',
                activitiesUpdated: relinkResult.activitiesUpdated,
                toOppName: relinkResult.toOppName,
                requeuedForSync: relinkResult.requeuedForSync,
                context: crmCtx,
              })}
            </p>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* v1.148.0 / v1.149.0: Evaluation ("Project") fields —
              collapsed by default (compact Status/Stage/Type, click to
              expand the full editor). Shown regardless of the date filter
              so it doesn't disappear when the range yields zero
              activities. */}
          {relatedId && relatedType && (
            <div className="mb-6 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('sf_activities.project_fields', 'Project Fields')}
              </p>
              {isCriteriaIqProjectLink(relatedType)
                ? <CriteriaIqProjectBox projectId={relatedId} fallbackName={whatName} />
                : <EvalFieldsPanel teamId={teamId} sobject={relatedType} relatedId={relatedId} relatedName={whatName} />}
            </div>
          )}
          {loading && (<div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>)}
          {!loading && rows.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('sf_activities.empty')}</p>
          )}
          {!loading && rows.length > 0 && (
            <div className="flex flex-col gap-6">
              {/* Summary chips */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <p className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <span>{t('sf_activities.by_contributor')}</span>
                    <span className="text-gray-700 dark:text-gray-300">
                      {byUserList.reduce((s, u) => s + u.count, 0)}/{byUserList.reduce((s, u) => s + u.hours, 0).toFixed(1)}h
                    </span>
                  </p>
                  <div className="flex flex-col gap-1">
                    {(() => {
                      const totalH = byUserList.reduce((s, u) => s + u.hours, 0)
                      return byUserList.map((u) => {
                        const pct = totalH > 0 ? Math.round((u.hours / totalH) * 100) : 0
                        return (
                          <div key={u.email} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate text-gray-700 dark:text-gray-300">{u.name}</span>
                            <span className="shrink-0 font-medium text-gray-900 dark:text-gray-100">
                              {u.count}/{u.hours.toFixed(1)}h — {pct}%
                            </span>
                          </div>
                        )
                      })
                    })()}
                  </div>
                </div>
                <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <p className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <span>{t('sf_activities.by_type')}</span>
                    <span className="text-gray-700 dark:text-gray-300">
                      {byTypeList.reduce((s, [, v]) => s + v.count, 0)}/{byTypeList.reduce((s, [, v]) => s + v.hours, 0).toFixed(1)}h
                    </span>
                  </p>
                  <div className="flex flex-col gap-1">
                    {(() => {
                      const totalH = byTypeList.reduce((s, [, v]) => s + v.hours, 0)
                      return byTypeList.map(([type, stats]) => {
                        const pct = totalH > 0 ? Math.round((stats.hours / totalH) * 100) : 0
                        return (
                          <div key={type} className="flex items-center justify-between gap-2 text-xs">
                            <span className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                              {stats.icon && (
                                <DynamicIcon
                                  name={stats.icon}
                                  className="h-3.5 w-3.5 shrink-0"
                                  {...(stats.color ? { style: { color: stats.color } } : {})}
                                />
                              )}
                              {type}
                            </span>
                            <span className="shrink-0 font-medium text-gray-900 dark:text-gray-100">
                              {stats.count}/{stats.hours.toFixed(1)}h — {pct}%
                            </span>
                          </div>
                        )
                      })
                    })()}
                  </div>
                </div>
              </div>

              {/* v1.122.0: breakdown by SF object type — only rendered
                  on the Account drill-down in Include All mode.
                  Buckets are already server-filtered (empty ones
                  omitted). Hidden entirely on Direct so the layout
                  stays clean when there's only one type. */}
              {isAccount && scope === 'include_all' && breakdown.length > 1 && (
                <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <p className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <span className="flex items-center gap-1.5">
                      {t('sf_activities.by_relationship', 'By Relationship')}
                      <SfRelationshipHelp />
                    </span>
                    <span className="text-gray-700 dark:text-gray-300">
                      {breakdown.reduce((s, b) => s + b.count, 0)}/{breakdown.reduce((s, b) => s + b.hours, 0).toFixed(1)}h
                    </span>
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {(() => {
                      const totalH = breakdown.reduce((s, b) => s + b.hours, 0)
                      const iconFor = (type: string) => type === 'Account' ? Building2 : type === 'Opportunity' ? Briefcase : type === 'Campaign' ? Megaphone : UserPlus
                      const labelFor = (type: string) => t(`sf.${type.toLowerCase()}` as const, type)
                      return breakdown.map((b) => {
                        const pct = totalH > 0 ? Math.round((b.hours / totalH) * 100) : 0
                        const Icon = iconFor(b.type)
                        return (
                          <div key={b.type} className="flex items-center justify-between gap-2 text-xs">
                            <span className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                              <Icon className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                              {labelFor(b.type)}
                            </span>
                            <span className="shrink-0 font-medium text-gray-900 dark:text-gray-100">
                              {b.count}/{b.hours.toFixed(1)}h — {pct}%
                            </span>
                          </div>
                        )
                      })
                    })()}
                  </div>
                </div>
              )}

              {/* Timeline (year > month > day accordion) */}
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('sf_activities.timeline')}
                </p>
                <div className="flex flex-col">
                  {Array.from(grouped.entries()).map(([yk, months]) => {
                    const yKey = `y:${yk}`
                    const yOpen = expanded.has(yKey)
                    const yHours = Array.from(months.values()).flatMap((m) => Array.from(m.values()).flat()).reduce((s, r) => s + Number(r.effortHours), 0)
                    return (
                      <div key={yk} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
                        <button type="button" onClick={() => toggle(yKey)} className="flex w-full items-center gap-1 py-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {yOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          {yk}
                          <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">· {yHours.toFixed(1)}h</span>
                        </button>
                        {yOpen && Array.from(months.entries()).map(([mk, days]) => {
                          const mKey = `m:${yk}:${mk}`
                          const mOpen = expanded.has(mKey)
                          const mHours = Array.from(days.values()).flat().reduce((s, r) => s + Number(r.effortHours), 0)
                          return (
                            <div key={mk} className="ml-4">
                              <button type="button" onClick={() => toggle(mKey)} className="flex w-full items-center gap-1 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                                {mOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                {mk}
                                <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">· {mHours.toFixed(1)}h</span>
                              </button>
                              {mOpen && Array.from(days.entries()).map(([dk, dayRows]) => {
                                const dKey = `d:${yk}:${mk}:${dk}`
                                const dOpen = expanded.has(dKey)
                                const dHours = dayRows.reduce((s, r) => s + Number(r.effortHours), 0)
                                return (
                                  <div key={dk} className="ml-4">
                                    <button type="button" onClick={() => toggle(dKey)} className="flex w-full items-center gap-1 py-1 text-xs text-gray-600 dark:text-gray-400">
                                      {dOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                      {dk}
                                      <span className="ml-2 text-gray-500 dark:text-gray-400">· {dHours.toFixed(1)}h · {dayRows.length}</span>
                                    </button>
                                    {dOpen && (
                                      <div className="ml-4 mb-2 flex flex-col gap-1.5">
                                        {dayRows.map((r) => {
                                          const color = r.activityTypeColor
                                          const tintStyle = color ? { backgroundColor: `${color}14`, borderLeft: `3px solid ${color}` } : undefined
                                          return (
                                            <div key={r.id} className="rounded-md border border-gray-200 p-2.5 dark:border-gray-700" style={tintStyle}>
                                              <div className="flex items-start justify-between gap-2">
                                                <div className="flex-1">
                                                  <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                                                    {r.activityTypeIcon && (
                                                      <DynamicIcon
                                                        name={r.activityTypeIcon}
                                                        className="h-3.5 w-3.5 shrink-0"
                                                        {...(color ? { style: { color } } : {})}
                                                      />
                                                    )}
                                                    {r.title}
                                                  </p>
                                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                                                    <Badge variant="secondary" style={color ? { backgroundColor: color, color: '#fff', borderColor: color } : undefined}>
                                                      {r.activityTypeName}
                                                    </Badge>
                                                    <span className="flex items-center gap-1"><User className="h-3 w-3" />{r.userDisplayName}</span>
                                                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatTimeInTZ(r.startDatetime, tzUser?.timezone ?? null)} · {Number(r.effortHours).toFixed(1)}h</span>
                                                  </div>
                                                  {r.notes && <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400 line-clamp-2">{r.notes}</p>}
                                                </div>
                                              </div>
                                            </div>
                                          )
                                        })}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Pre-ImpactIQ Salesforce history. Below the live timeline and
              collapsed by default, so it reads as supplementary context
              rather than more of the same data. Renders nothing when the
              record has no history. */}
          {histBase && !!histMeta?.count && (
            <SfHistoricalSection
              url={buildHistoryUrl(histBase)}
              count={histMeta.count}
              estimatedHours={histMeta.estimatedHours}
            />
          )}
        </div>
      </div>
    </div>
  )
}
