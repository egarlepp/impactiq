import { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useDashboardPresets, type DashboardPreset } from '../hooks/useDashboardPresets.js'
import { X as XIcon, Bookmark, User, Package, Target, Compass, RefreshCw, CalendarOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTeam } from '../hooks/useTeam.js'
import { api } from '../lib/api.js'
import { useSearchParams } from 'react-router-dom'
import { useCurrentUser } from '../hooks/useCurrentUser.js'
import { TeamHeatmap } from '../components/leader/TeamHeatmap.js'
import { ActivityBreakdown } from '../components/leader/ActivityBreakdown.js'
import { ActivitySubtypeBreakdown } from '../components/leader/ActivitySubtypeBreakdown.js'
import { AccountBurn } from '../components/leader/AccountBurn.js'
import { AnomalyCallouts } from '../components/leader/AnomalyCallouts.js'
import { CapacityTrend } from '../components/leader/CapacityTrend.js'
import { ThisWeekCapacity } from '../components/leader/ThisWeekCapacity.js'
import { PlanVsActual } from '../components/leader/PlanVsActual.js'
import { LoggingCompliance } from '../components/leader/LoggingCompliance.js'
import { LoggingLag } from '../components/leader/LoggingLag.js'
import { ActivityMix } from '../components/leader/ActivityMix.js'
import { AccountConcentration } from '../components/leader/AccountConcentration.js'
import { WowDelta } from '../components/leader/WowDelta.js'
import { ProductsBreakdown } from '../components/leader/ProductsBreakdown.js'
import { OpportunityRoiScatter } from '../components/leader/OpportunityRoiScatter.js'
import { CostPerAcv } from '../components/leader/CostPerAcv.js'
import { ManagerRollup } from '../components/leader/ManagerRollup.js'
import { SalesTeamBreakdown } from '../components/leader/SalesTeamBreakdown.js'
import { MostExpensive } from '../components/leader/MostExpensive.js'
import { UserLeaderboard } from '../components/leader/UserLeaderboard.js'
import { TeamActivityDeepDive } from '../components/leader/TeamActivityDeepDive.js'
import { WonWithoutPoc } from '../components/leader/WonWithoutPoc.js'
import { ClosedLostReview } from '../components/leader/ClosedLostReview.js'
import { ProjectCosting } from '../components/leader/ProjectCosting.js'
import { AttachRate } from '../components/leader/AttachRate.js'
import { HistoryDashboard } from '../components/leader/HistoryDashboard.js'
import { SfDisconnected } from '../components/leader/SfDisconnected.js'
import { OutlookDisconnected } from '../components/leader/OutlookDisconnected.js'
import { AiAssessmentScores } from '../components/leader/AiAssessmentScores.js'
import { Spinner } from '../components/ui/spinner.js'
import { PageHeader } from '../components/ui/page-header.js'
import { MultiSelect } from '../components/ui/multi-select.js'
import { SingleSelect } from '../components/ui/single-select.js'
import { SubteamFilter } from '../components/ui/subteam-filter.js'
import { SubtypeFilter } from '../components/ui/subtype-filter.js'
import { LayoutDashboard, Globe, CalendarClock, GitCompare, CalendarRange, DollarSign, AlertCircle } from 'lucide-react'
import { cn } from '../lib/utils.js'
import { useTeamProducts } from '../hooks/useProducts.js'
import type { CompareMode } from '../lib/period.js'
import { setDashDateParams, type DashDateBasis } from '../lib/dashboard-fetch.js'
import { DisplayCurrencyProvider, DisplayCurrencyControls, useDisplayCurrency, CURRENCY_SYMBOL } from '../lib/displayCurrency.js'
import { useProjectsEnabled } from '../store/evaluationSource.js'
import { useCrmLabelContext } from '../store/crmProvider.js'
import { DASHBOARD_GROUPS as GROUPS, isDashboardTab, visibleDashboardGroups, type DashboardTab } from '../lib/dashboardTabs.js'

type Tab = DashboardTab

// Capacity dashboards that chart uncaptured meeting time — the only tabs
// where the Non-Activities inclusion toggle applies.
const NON_ACTIVITY_TABS = new Set<Tab>(['heatmap', 'thisWeek', 'capacityTrend'])

// 0 is the "All time" sentinel — server rangeFor() treats it as no lower
// bound on activity.start_datetime. Keep it last in the picker.
const WEEKS_OPTIONS = [1, 4, 8, 12, 0]

// v1.137.0: which groups show the Stage / Forecast filter chips + the
// Refresh-from-SF button. Filters only make sense for Opp-touching
// dashboards (Manager / Revenue / Accounts).
const STAGE_FILTER_GROUPS = new Set(['leader.group.manager', 'leader.group.revenue', 'leader.group.accounts', 'leader.group.infrastructure', 'leader.group.coverage'])

// ACV-range (opportunity size) filter buckets. Shown alongside the Stage /
// Forecast chips on the same Opp-touching dashboards. Each `value` is a slug
// the server parses into a [min, max) range ("+" = no upper bound). Selecting
// several buckets unions them.
const ACV_BUCKETS: string[] = [
  '0-5000', '5000-10000', '10000-25000', '25000-50000', '50000-75000',
  '75000-100000', '100000-200000', '200000-500000', '500000+',
]

// Format a bucket slug as a human label with the active currency symbol, e.g.
// "< $5K", "$25K–$50K", "$500K+". Values are nominal in the display currency
// (the server maps the bounds back to USD via the FX rate on cost dashboards).
function acvBucketLabel(value: string, sym: string): string {
  const k = (n: number) => `${sym}${n / 1000}K`
  if (value.endsWith('+')) return `${k(Number(value.slice(0, -1)))}+`
  const [a, b] = value.split('-').map(Number)
  return a === 0 ? `< ${k(b!)}` : `${k(a!)}–${k(b!)}`
}

// The ACV-range chip. A dedicated component so it can read the "Show Costs In"
// display currency from context (the parent page renders the provider, so it
// can't read the hook itself). On cost dashboards the bucket labels show the
// selected currency's symbol; elsewhere they stay in USD.
function AcvRangeSelect({ selected, onChange, costTab }: { selected: string[]; onChange: (v: string[]) => void; costTab: boolean }) {
  const { t } = useTranslation()
  const { currency } = useDisplayCurrency()
  const sym = costTab ? (CURRENCY_SYMBOL[currency] ?? '$') : '$'
  return (
    <MultiSelect
      label={t('leader.filter_acv', 'ACV Range')}
      labelIcon={DollarSign}
      placeholder={t('leader.filter_all', 'All')}
      options={ACV_BUCKETS.map((v) => ({ value: v, label: acvBucketLabel(v, sym), icon: DollarSign }))}
      selected={selected}
      onChange={onChange}
    />
  )
}

// Dashboards that ignore the Compare (WOW/MOM/QOQ/YOY) period selector —
// their components don't read `compareMode`, so hide the chips for them.
// Gated per-tab (not per-group) because the Accounts group is mixed:
// Burn / Concentration use Compare but Most Expensive doesn't.
const NO_COMPARE_TABS = new Set<Tab>([
  'oppRoi', 'costPerAcv', 'mostExpensive', 'managerRollup',
  'sales_team_breakdown', 'userLeaderboard', 'projectCosting',
  'teamActivityDeepDive', 'wonWithoutPoc', 'historyOverview',
  'sfDisconnected', 'closedLostReview', 'outlookDisconnected', 'aiAssessments',
])

// v1.214.0: tabs where the Subteam / Team-member / Products chips don't
// apply and would read as broken (changing them moves nothing). Historical
// rows predate teams and carry no product linkage. Date chips still work.
const NO_MEMBER_FILTER_TABS = new Set<Tab>(['historyOverview'])

// v1.265.0: tabs whose server route actually carries the Subtype dimension
// (§7/Batch 6) — only Activity Type Breakdown and Activity Mix group by
// subtypeName today. The chip itself also self-hides per team (see
// SubtypeFilter) when Subtypes aren't configured/enabled, but gating here
// too keeps it off tabs that would silently ignore the selection.
const SUBTYPE_FILTER_TABS = new Set<Tab>(['breakdown', 'subtypeBreakdown', 'mix', 'teamActivityDeepDive'])

// Dashboards that display costs / currency values. The shared "Show Costs In"
// selector + FX-date pill in the header apply to these.
const COST_TABS = new Set<Tab>([
  'costPerAcv', 'oppRoi', 'mostExpensive', 'managerRollup',
  'userLeaderboard', 'projectCosting', 'teamActivityDeepDive', 'wonWithoutPoc',
  'closedLostReview',
])

// Build FY/FQ quick-pick options (previous / current / next fiscal year plus
// their quarters) from the fiscal config; each value encodes start|end dates.
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function buildFyFqOptions(cfg: { startMonth: number; yearNaming: 'same' | 'next' }): Array<{ value: string; label: string; group: string }> {
  const { startMonth, yearNaming } = cfg
  const today = new Date()
  const m = today.getMonth() + 1, y = today.getFullYear()
  const fiscalStartYear0 = m >= startMonth ? y : y - 1
  const curLabel = yearNaming === 'next' ? fiscalStartYear0 + 1 : fiscalStartYear0
  const isCal = startMonth === 1
  const opts: Array<{ value: string; label: string; group: string }> = []
  for (const labelYear of [curLabel - 1, curLabel, curLabel + 1]) {
    const startCalYear = yearNaming === 'next' ? labelYear - 1 : labelYear
    const fyStart = new Date(startCalYear, startMonth - 1, 1)
    const fyEnd = new Date(startCalYear + 1, startMonth - 1, 0)
    const yLabel = isCal ? String(labelYear) : `FY${String(labelYear).slice(-2)}`
    opts.push({ value: `${isoDate(fyStart)}|${isoDate(fyEnd)}`, label: `${yLabel} — Full year`, group: yLabel })
    for (let q = 1; q <= 4; q++) {
      const qStart = new Date(startCalYear, startMonth - 1 + (q - 1) * 3, 1)
      const qEnd = new Date(startCalYear, startMonth - 1 + q * 3, 0)
      opts.push({ value: `${isoDate(qStart)}|${isoDate(qEnd)}`, label: `Q${q} ${yLabel}`, group: yLabel })
    }
  }
  return opts
}

export default function Dashboard() {
  const { t } = useTranslation()
  const projectsOn = useProjectsEnabled()
  const { activeTeam, active, loading: teamLoading } = useTeam()
  const { user } = useCurrentUser()
  // The open dashboard is in the URL (?tab=), so search results and links can
  // open a specific one; the URL follows the picker and the picker the URL.
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const [tab, setTab] = useState<Tab>(() => (isDashboardTab(tabParam) ? tabParam : 'heatmap'))
  useEffect(() => {
    if (isDashboardTab(tabParam) && tabParam !== tab) setTab(tabParam)
  }, [tabParam])
  useEffect(() => {
    if (tabParam === tab) return
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', tab)
      return next
    }, { replace: true })
  }, [tab])
  // Include uncaptured Outlook meeting time ("non-activities") in the capacity
  // dashboards. Default on; persisted like the Activities page's own toggle.
  const [includeNonActivities, setIncludeNonActivities] = useState<boolean>(() => {
    try { return localStorage.getItem('dashboard.includeNonActivities') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('dashboard.includeNonActivities', includeNonActivities ? '1' : '0') } catch { /* ignore */ }
  }, [includeNonActivities])
  const [weeksBack, setWeeksBack] = useState(8)
  // Products filter (multi-select). Only meaningful when a concrete team is
  // active — the Products endpoint is team-scoped, and "All Teams" mode
  // would need a union we don't build yet.
  const [productIds, setProductIds] = useState<string[]>([])
  // v1.137.0: SF Sales Stage + Forecast Category filters. Only rendered
  // on Manager / Revenue / Accounts groups (STAGE_FILTER_GROUPS).
  const [stageFilter, setStageFilter] = useState<string[]>([])
  const [forecastFilter, setForecastFilter] = useState<string[]>([])
  // ACV-range (opportunity size) filter. Same gating as Stage / Forecast;
  // when set, non-Opportunity activities are excluded server-side.
  const [acvFilter, setAcvFilter] = useState<string[]>([])
  // v1.265.0: Subtype filter (§7/Batch 6) — only meaningful on the tabs in
  // SUBTYPE_FILTER_TABS; SubtypeFilter itself also self-hides per team when
  // Subtypes aren't configured/enabled.
  const [subtypeIds, setSubtypeIds] = useState<string[]>([])
  const [stageOptions, setStageOptions] = useState<string[]>([])
  // HubSpot with several deal pipelines: stage label → pipeline name, used
  // as the stage picker's groups instead of the "Legacy Stages" split.
  const [stageGroups, setStageGroups] = useState<Record<string, string> | null>(null)
  const crmCtx = useCrmLabelContext()
  const [forecastOptions, setForecastOptions] = useState<string[]>([])
  const [refreshing, setRefreshing] = useState(false)
  // v1.273.0: live countdown until this user can click "Refresh from
  // Salesforce" again (throttle raised 10min -> 30min). Fetched once on
  // mount so a reload/revisit shows the real remaining wait immediately,
  // not just after the next 429.
  const [refreshRetrySec, setRefreshRetrySec] = useState(0)
  useEffect(() => {
    void api.get<{ lastClickedAt: string | null; retryAfterSec: number }>('/api/dashboards/refresh-opp-snapshots/status')
      .then((res) => { if (res.data) setRefreshRetrySec(res.data.retryAfterSec) })
  }, [])
  useEffect(() => {
    if (refreshRetrySec <= 0) return
    const id = setInterval(() => setRefreshRetrySec((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(id)
  }, [refreshRetrySec > 0])
  const teamProducts = useTeamProducts(activeTeam?.id ?? null)
  // Team member filter. Default: current user for non-admins, "All" for admins.
  const [teamMembers, setTeamMembers] = useState<Array<{ id: string; displayName: string; email: string }>>([])
  // v1.265.0: multi-select, matching Scheduling's SubteamFilter mode="multi" —
  // checkboxes for subteams AND individually-picked people, unioned server-
  // side via the `userIds` param every dashboard route now reads. Unlike
  // Scheduling, there's deliberately no "default to my own subteam" here:
  // this is reporting, not a personal calendar view, so it starts at "All".
  const [userIds, setUserIds] = useState<string[]>([])
  const [subteams, setSubteams] = useState<Array<{ id: string; name: string }>>([])
  const [subteamIds, setSubteamIds] = useState<string[]>([])
  // Union of every selected subteam's member ids, kept as a cache keyed by
  // subteamId so re-selecting a previously-loaded subteam doesn't re-fetch.
  const [subteamMembersById, setSubteamMembersById] = useState<Record<string, string[]>>({})
  useEffect(() => {
    if (!activeTeam) { setTeamMembers([]); setSubteams([]); return }
    void fetch(`/api/teams/${activeTeam.id}/members`).then((r) => r.json()).then((j) => {
      const rows = (j?.data ?? []) as Array<{ id: string; displayName: string; email: string }>
      setTeamMembers(rows)
      // Default: current user if they're a member, else All.
      if (user && !user.isAppAdmin && rows.some((r) => r.id === user.id)) setUserIds([user.id])
      else setUserIds([])
    }).catch(() => setTeamMembers([]))
    void fetch(`/api/teams/${activeTeam.id}/subteams`).then((r) => r.json()).then((j) => {
      setSubteams((j?.data ?? []) as Array<{ id: string; name: string }>)
    }).catch(() => setSubteams([]))
    setSubteamIds([])
    setSubteamMembersById({})
    setSubtypeIds([])
    // v1.137.0: distinct Stage + Forecast values across activities under
    // this team, powering the two chip pickers. Cheap query; fires once
    // per team switch.
    void fetch(`/api/dashboards/stage-forecast-options?teamId=${activeTeam.id}`)
      .then((r) => r.json())
      .then((j) => {
        setStageOptions(((j?.data?.stages ?? []) as string[]).filter(Boolean))
        setStageGroups((j?.data?.stageGroups as Record<string, string> | null | undefined) ?? null)
        setForecastOptions(((j?.data?.forecast ?? []) as string[]).filter(Boolean))
      })
      .catch(() => { setStageOptions([]); setStageGroups(null); setForecastOptions([]) })
  }, [activeTeam?.id, user?.id, user?.isAppAdmin])

  // Fetch members for any selected subteam not already cached.
  useEffect(() => {
    if (!activeTeam) return
    const missing = subteamIds.filter((id) => !(id in subteamMembersById))
    if (missing.length === 0) return
    void Promise.all(missing.map((id) =>
      fetch(`/api/teams/${activeTeam.id}/subteams/${id}/members`).then((r) => r.json())
        .then((j) => [id, ((j?.data ?? []) as Array<{ id: string }>).map((r) => r.id)] as const)
        .catch(() => [id, [] as string[]] as const),
    )).then((entries) => {
      setSubteamMembersById((prev) => {
        const next = { ...prev }
        for (const [id, ids] of entries) next[id] = ids
        return next
      })
    })
  }, [activeTeam?.id, subteamIds, subteamMembersById])

  // The generic multi-person filter every dashboard route reads: union of
  // every checked subteam's members and every individually-picked person.
  // Empty = no filter (show everyone in team scope), matching the previous
  // "All" behavior.
  const effectiveMemberIds = useMemo(() => {
    const set = new Set<string>(userIds)
    for (const id of subteamIds) for (const uid of subteamMembersById[id] ?? []) set.add(uid)
    return Array.from(set)
  }, [userIds, subteamIds, subteamMembersById])
  // Custom start/end date range. When set, overrides the weeksBack preset
  // for endpoints that accept explicit dates; components that only accept
  // weeksBack still use the preset (converted from the custom range).
  const [customStart, setCustomStart] = useState<string>('')
  const [customEnd, setCustomEnd] = useState<string>('')
  const isCustomRange = !!customStart && !!customEnd
  const effectiveWeeksBack = (() => {
    if (!isCustomRange) return weeksBack
    const s = new Date(customStart)
    const e = new Date(customEnd)
    return Math.max(1, Math.round((e.getTime() - s.getTime()) / (7 * 24 * 60 * 60 * 1000)))
  })()
  const [compareMode, setCompareMode] = useState<CompareMode>('off')

  // v1.195.0: what the date window filters against (default: date of activity),
  // persisted across tabs. Published to the shared fetch layer so every
  // dashboard request carries it.
  const [dateBasis, setDateBasis] = useState<DashDateBasis>(() => {
    try { return (localStorage.getItem('dashboard.dateBasis') as DashDateBasis) || 'activity' } catch { return 'activity' }
  })
  useEffect(() => { try { localStorage.setItem('dashboard.dateBasis', dateBasis) } catch { /* ignore */ } }, [dateBasis])
  // Publish the basis + explicit window synchronously so children read the
  // current values when they (re)mount and fetch.
  setDashDateParams({ basis: dateBasis, start: customStart, end: customEnd })

  // Fiscal-year config drives the FY/FQ quick-pick (prev / current / next
  // year and their quarters). Falls back to calendar quarters.
  const [fiscal, setFiscal] = useState<{ startMonth: number; yearNaming: 'same' | 'next' }>({ startMonth: 1, yearNaming: 'same' })
  useEffect(() => {
    void fetch('/api/admin/fiscal-year').then((r) => r.json()).then((j) => {
      if (j?.data) setFiscal({ startMonth: Number(j.data.startMonth) || 1, yearNaming: j.data.yearNaming === 'next' ? 'next' : 'same' })
    }).catch(() => { /* keep default */ })
  }, [])
  const fyfqOptions = useMemo(() => buildFyFqOptions(fiscal), [fiscal.startMonth, fiscal.yearNaming])

  // ─── Filter presets ────────────────────────────────────────────────
  const { presets, save: savePreset, remove: removePreset } = useDashboardPresets()
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const presetsBtnRef = useRef<HTMLButtonElement | null>(null)
  const presetsPopRef = useRef<HTMLDivElement | null>(null)
  const [presetsRect, setPresetsRect] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    if (!presetsOpen || !presetsBtnRef.current) return
    const b = presetsBtnRef.current.getBoundingClientRect()
    setPresetsRect({ top: b.bottom + 4, right: window.innerWidth - b.right })
  }, [presetsOpen])
  useEffect(() => {
    if (!presetsOpen) return
    const onClick = (e: MouseEvent) => {
      const n = e.target as Node
      if (presetsBtnRef.current?.contains(n)) return
      if (presetsPopRef.current?.contains(n)) return
      setPresetsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [presetsOpen])

  function applyPreset(p: DashboardPreset) {
    const f = p.filters as Record<string, unknown>
    if (typeof f['tab'] === 'string') setTab(f['tab'] as Tab)
    if (typeof f['weeksBack'] === 'number') setWeeksBack(f['weeksBack'] as number)
    setUserIds(Array.isArray(f['userIds']) ? (f['userIds'] as string[]) : [])
    if (Array.isArray(f['productIds'])) setProductIds(f['productIds'] as string[])
    if (typeof f['customStart'] === 'string') setCustomStart(f['customStart'] as string)
    if (typeof f['customEnd'] === 'string') setCustomEnd(f['customEnd'] as string)
    if (typeof f['compareMode'] === 'string') setCompareMode(f['compareMode'] as CompareMode)
    if (typeof f['dateBasis'] === 'string') setDateBasis(f['dateBasis'] as DashDateBasis)
    // v1.217.0: these four used to be dropped on save, so a preset named
    // "Commit deals over $100k" restored neither the stage nor the ACV
    // band. Presets saved before this release don't carry the keys — reset
    // to the empty default rather than leaving whatever the previous
    // preset set, so applying a preset always yields one whole state.
    setSubteamIds(Array.isArray(f['subteamIds']) ? (f['subteamIds'] as string[]) : [])
    setStageFilter(Array.isArray(f['stageFilter']) ? (f['stageFilter'] as string[]) : [])
    setForecastFilter(Array.isArray(f['forecastFilter']) ? (f['forecastFilter'] as string[]) : [])
    setAcvFilter(Array.isArray(f['acvFilter']) ? (f['acvFilter'] as string[]) : [])
    setSubtypeIds(Array.isArray(f['subtypeIds']) ? (f['subtypeIds'] as string[]) : [])
    setPresetsOpen(false)
  }
  async function handleSavePreset() {
    const name = presetName.trim()
    if (!name) return
    setSavingPreset(true)
    await savePreset(name, {
      tab, weeksBack, userIds, productIds, customStart, customEnd, compareMode, dateBasis,
      subteamIds, stageFilter, forecastFilter, acvFilter, subtypeIds,
    })
    setSavingPreset(false)
    setPresetName('')
  }

  const visibleGroups = visibleDashboardGroups(user, projectsOn)

  useEffect(() => {
    // If the current tab is not permitted, jump to the first visible one.
    const allowed = visibleGroups.flatMap((g) => g.tabs.map((tt) => tt.key))
    if (allowed.length > 0 && !allowed.includes(tab)) setTab(allowed[0] as Tab)
  }, [visibleGroups.map((g) => g.tabs.map((tt) => tt.key).join(',')).join('|')])

  if (teamLoading) {
    return <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6" /></div>
  }

  // All Teams selected → server unions across every team the user can see.
  const isAll = active?.isAll === true
  const scopeTeamId = isAll ? 'all' : activeTeam?.id

  if (!scopeTeamId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        {t('leader.no_team_selected')}
      </div>
    )
  }

  return (
    <DisplayCurrencyProvider>
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={LayoutDashboard}
        title={t('leader.dashboard')}
        subtitle={isAll ? t('nav.all_teams') : activeTeam?.name ?? null}
      />
      {/* Timezone note + Dashboard picker share one tight row. Picker sits
          on the left, timezone note trails it. */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-1 dark:border-gray-700 dark:bg-gray-900">
        {(() => {
          // Show the CURRENT tab's category (glyph + name) as the chip
          // prefix instead of the static "Team Dashboard:" — makes the
          // scannable grouping visible without opening the picker.
          const activeGroup = GROUPS.find((g) => g.tabs.some((tt) => tt.key === tab)) ?? GROUPS[0]!
          return (
            <SingleSelect
              label={`${activeGroup.glyph}  ${t(activeGroup.groupKey)}`}
              value={tab}
              onChange={(v) => setTab(v as Tab)}
              options={visibleGroups.flatMap((g) => g.tabs.map((tt) => ({
                value: tt.key,
                label: t(tt.labelKey, { context: crmCtx }),
                group: `${g.glyph}  ${t(g.groupKey)}`,
              })))}
            />
          )
        })()}
        <div className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
          <Globe className="h-3 w-3" />
          {t('activity.timezone_note', {
            tz: user?.timezone
              || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'),
          })}
        </div>
        {/* Right side of the header row: cost controls (when applicable) +
            the Presets picker, pushed to the far right next to the timezone. */}
        <div className="ml-auto flex items-center gap-3">
          {COST_TABS.has(tab) && <DisplayCurrencyControls />}
          <button
            ref={presetsBtnRef}
            type="button"
            onClick={() => setPresetsOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            title={t('leader.presets.title')}
          >
            <Bookmark className="h-3 w-3" />
            {t('leader.presets.title')}
          </button>
          {presetsOpen && presetsRect && createPortal(
            <div
              ref={presetsPopRef}
              className="fixed z-[100] w-64 rounded-md border border-gray-200 bg-white p-2 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-900"
              style={{ top: presetsRect.top, right: presetsRect.right }}
            >
              <div className="mb-1 font-semibold text-gray-700 dark:text-gray-200">
                {t('leader.presets.save_current')}
              </div>
              <div className="mb-2 flex items-center gap-1">
                <input
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder={t('leader.presets.name_placeholder')}
                  className="flex-1 rounded border border-gray-200 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  maxLength={80}
                />
                <button
                  type="button"
                  onClick={() => void handleSavePreset()}
                  disabled={!presetName.trim() || savingPreset}
                  className="rounded bg-blue-600 px-2 py-1 text-white disabled:opacity-50"
                >
                  {t('leader.presets.save')}
                </button>
              </div>
              <div className="max-h-56 overflow-y-auto border-t border-gray-100 pt-1 dark:border-gray-800">
                {presets.length === 0 ? (
                  <p className="p-2 text-gray-400">{t('leader.presets.empty')}</p>
                ) : presets.map((p) => (
                  <div key={p.id} className="group flex items-center justify-between rounded px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-800">
                    <button
                      type="button"
                      onClick={() => applyPreset(p)}
                      className="flex-1 truncate text-left text-gray-700 dark:text-gray-200"
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removePreset(p.id)}
                      className="ml-1 hidden text-gray-400 hover:text-red-600 group-hover:inline"
                      title={t('leader.presets.delete')}
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )}
        </div>
      </div>

      {/* Filters row — left-aligned */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center gap-3">
          {/* Non-activity inclusion — only shown on capacity dashboards where
              uncaptured meeting time is charted. Mirrors the Activities page
              Show-Non-Activities toggle (same CalendarOff icon), default on. */}
          {NON_ACTIVITY_TABS.has(tab) && (
            <button
              type="button"
              onClick={() => setIncludeNonActivities((v) => !v)}
              aria-pressed={includeNonActivities}
              title={t('leader.non_activities.toggle')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium',
                includeNonActivities
                  ? 'border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
                  : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800',
              )}
            >
              <CalendarOff className="h-3 w-3" />
              {t('leader.non_activities.toggle')}
            </button>
          )}
          {activeTeam && subteams.length > 0 && !NO_MEMBER_FILTER_TABS.has(tab) && (
            <SubteamFilter
              teamId={activeTeam.id}
              subteams={subteams}
              subteamIds={subteamIds}
              onSubteamIdsChange={setSubteamIds}
              userIds={userIds}
              onUserIdsChange={setUserIds}
            />
          )}
          {activeTeam && teamMembers.length > 0 && !NO_MEMBER_FILTER_TABS.has(tab) && (
            <MultiSelect
              label={t('leader.filter_user')}
              labelIcon={User}
              placeholder={t('leader.filter_user_all')}
              options={teamMembers.map((m) => ({ value: m.id, label: m.displayName, icon: User }))}
              selected={userIds}
              onChange={setUserIds}
            />
          )}
          {activeTeam && teamProducts.length > 0 && !NO_MEMBER_FILTER_TABS.has(tab) && (
            <MultiSelect
              label={t('leader.filter_products')}
              labelIcon={Package}
              placeholder={t('leader.filter_products_all')}
              options={teamProducts
                .filter((p) => p.isActive)
                .map((p) => ({
                  value: p.id,
                  label: p.name,
                  hint: p.abbreviation ?? undefined,
                  // v1.134.0: show the tenant-uploaded product icon when
                  // available; fall back to the generic Package glyph.
                  ...(p.iconDataUrl ? { iconUrl: p.iconDataUrl } : { icon: Package }),
                }))}
              selected={productIds}
              onChange={setProductIds}
            />
          )}
          {activeTeam && SUBTYPE_FILTER_TABS.has(tab) && (
            <SubtypeFilter selected={subtypeIds} onChange={setSubtypeIds} />
          )}
          {STAGE_FILTER_GROUPS.has((GROUPS.find((g) => g.tabs.some((tt) => tt.key === tab)) ?? GROUPS[0]!).groupKey) && (
            <>
              <MultiSelect
                label={t('leader.filter_sales_stage', { context: crmCtx })}
                labelIcon={Target}
                placeholder={t('leader.filter_all', 'All')}
                // Current numbered stages ("0. …" – "7. …") render flat;
                // everything else is tucked under a collapsed "Legacy Stages"
                // group so the picker leads with the live pipeline stages.
                // HubSpot stages aren't numbered: they group by pipeline when
                // the portal has several, and render flat otherwise.
                options={stageOptions.map((s) => ({
                  value: s,
                  label: s,
                  icon: Target,
                  ...(crmCtx === 'hubspot'
                    ? (stageGroups?.[s] ? { group: stageGroups[s] } : {})
                    : (/^\d+\./.test(s.trim()) ? {} : { group: t('leader.legacy_stages') })),
                }))}
                selected={stageFilter}
                onChange={setStageFilter}
              />
              <MultiSelect
                label={t('leader.filter_forecast', 'Forecast')}
                labelIcon={Compass}
                placeholder={t('leader.filter_all', 'All')}
                options={forecastOptions.map((s) => ({ value: s, label: s, icon: Compass }))}
                selected={forecastFilter}
                onChange={setForecastFilter}
              />
              <AcvRangeSelect selected={acvFilter} onChange={setAcvFilter} costTab={COST_TABS.has(tab)} />
              <button
                type="button"
                disabled={refreshing || refreshRetrySec > 0}
                onClick={async () => {
                  setRefreshing(true)
                  try {
                    // api.post attaches the CSRF header; the endpoint carries
                    // its own per-user throttle (no teamId needed).
                    const res = await api.post<unknown>('/api/dashboards/refresh-opp-snapshots', {})
                    const meta = res.meta as { retryAfterSec?: number; retryAfter?: number } | undefined
                    const retrySec = meta?.retryAfterSec ?? meta?.retryAfter
                    // v1.273.0: every non-throttled response also carries the
                    // fresh 30min retryAfterSec (the throttle timestamp gets
                    // stamped regardless of whether the refresh itself
                    // succeeded), so the countdown starts on any real attempt.
                    if (retrySec != null) setRefreshRetrySec(retrySec)
                    if (res.error === 'throttled') {
                      alert(t('leader.refresh_throttled', `Refresh available in ${Math.ceil((retrySec ?? 0) / 60)} min.`, { min: Math.ceil((retrySec ?? 0) / 60) }))
                    } else if (res.error === 'no_admin_sf_connection') {
                      // v1.275.0: the clicking user is often a Team Leader,
                      // not an App Admin — they can't act on "ask an App
                      // Admin" if they ARE one, and a non-admin can't act on
                      // "go connect it yourself". Branch on the current
                      // user's own role so the message always points at
                      // something the reader can actually do.
                      alert(user?.isAppAdmin
                        ? t('leader.refresh_no_sf_connection_admin', 'Refresh failed: no admin Salesforce connection is configured. Go to Admin → Integrations to connect one.')
                        : t('leader.refresh_no_sf_connection', 'Refresh failed: no admin Salesforce connection is configured. Contact your App Admin to connect one under Admin → Integrations.'))
                    } else if (res.error === 'errors.crm.provider_mismatch') {
                      alert(t('errors.crm.provider_mismatch'))
                    } else if (res.error?.startsWith('errors.')) {
                      alert(t('leader.refresh_failed', { error: t(res.error) }))
                    } else if (res.error) {
                      // v1.271.0: previously silent — any non-throttle error
                      // (a genuine failure, a dropped connection) left the
                      // button looking like it did nothing at all. Always
                      // surface something now.
                      alert(t('leader.refresh_failed', 'Refresh failed: {{error}}', { error: res.error }))
                    } else {
                      window.location.reload()
                    }
                  } finally {
                    setRefreshing(false)
                  }
                }}
                title={refreshRetrySec > 0
                  ? t('leader.refresh_throttled', `Refresh available in ${Math.ceil(refreshRetrySec / 60)} min.`, { min: Math.ceil(refreshRetrySec / 60) })
                  : t('leader.refresh_from_sf', { context: crmCtx })}
                aria-label={t('leader.refresh_from_sf', { context: crmCtx })}
                className="flex h-7 items-center gap-1 rounded border border-gray-200 bg-white px-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshRetrySec > 0 && (
                  <span className="tabular-nums">{`${Math.floor(refreshRetrySec / 60)}:${String(refreshRetrySec % 60).padStart(2, '0')}`}</span>
                )}
              </button>
            </>
          )}
          {!NO_COMPARE_TABS.has(tab) && (
            <SingleSelect
              label={t('leader.compare')}
              labelIcon={GitCompare}
              value={compareMode}
              onChange={(v) => setCompareMode(v as CompareMode)}
              options={(['off', 'wow', 'mom', 'qoq', 'yoy'] as CompareMode[]).map((m) => ({
                value: m,
                label: m === 'off' ? t('leader.compare_off') : m.toUpperCase(),
              }))}
            />
          )}
          {/* Date basis — what the Start/End window filters against. Default
              Activity. Shown before the range/date controls. */}
          <SingleSelect
            label={t('leader.date_basis_label')}
            labelIcon={CalendarClock}
            value={dateBasis}
            onChange={(v) => setDateBasis(v as DashDateBasis)}
            options={[
              { value: 'activity', label: t('leader.date_basis_activity'), description: t('leader.date_basis_activity_hint') },
              { value: 'created', label: t('leader.date_basis_created'), description: t('leader.date_basis_created_hint') },
              { value: 'close', label: t('leader.date_basis_close'), description: t('leader.date_basis_close_hint') },
            ]}
          />
          {/* FY / FQ quick-pick — sets the custom Start/End window (overrides
              the weeks Range) from the fiscal calendar. */}
          <SingleSelect
            label={t('leader.fy_fq')}
            labelIcon={CalendarRange}
            value={isCustomRange ? `${customStart}|${customEnd}` : ''}
            placeholder={t('leader.fy_fq_placeholder')}
            onChange={(v) => {
              const [s, e] = v.split('|')
              if (s && e) { setCustomStart(s); setCustomEnd(e) }
            }}
            options={fyfqOptions}
          />
          <SingleSelect
            label={t('leader.range')}
            labelIcon={CalendarRange}
            value={isCustomRange ? 'custom' : String(weeksBack)}
            onChange={(v) => {
              if (v === 'custom') return
              setWeeksBack(Number(v)); setCustomStart(''); setCustomEnd('')
            }}
            options={[
              ...WEEKS_OPTIONS.map((w) => ({
                value: String(w),
                label: w === 0 ? t('leader.range_all', 'All') : `${w}w`,
              })),
              ...(isCustomRange ? [{ value: 'custom', label: t('leader.range_custom', 'Custom') }] : []),
            ]}
          />
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="rounded border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              title={t('leader.range_start')}
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="rounded border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              title={t('leader.range_end')}
            />
            {isCustomRange && (
              <button
                type="button"
                onClick={() => { setCustomStart(''); setCustomEnd('') }}
                className="text-[10px] text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
              >
                {t('leader.range_clear_custom')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ACV-range filter is Opportunity-scoped: any non-Opp activity is
          dropped while a range is active. Tell the leader so an unexpectedly
          low total isn't read as missing data. */}
      {acvFilter.length > 0 && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{t('leader.filter_acv_note', 'Non-opportunity activities are excluded while an ACV range is applied.')}</span>
        </div>
      )}

      {/* v1.220.0: anomaly callouts. Sits above the tab content rather than
          inside a tab, because the whole point is that the leader shouldn't
          have to know which dashboard the problem lives on. Fixed window
          (last completed week vs an 8-week baseline), so it deliberately
          ignores the date filter — see the service comment. */}
      <div className="mx-6 mt-3">
        <AnomalyCallouts teamId={scopeTeamId ?? null} productIds={productIds} />
      </div>

      {/* Content. The `key` forces a remount when the date basis or custom
          window changes — those flow through the module-level dashDateParams
          (not props), so a remount is what re-triggers each component's fetch. */}
      <div key={`${dateBasis}|${customStart}|${customEnd}`} className="flex-1 overflow-y-auto p-6">
        {tab === 'heatmap' && <TeamHeatmap teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} includeNonActivities={includeNonActivities} />}
        {tab === 'breakdown' && <ActivityBreakdown teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} subtypeIds={subtypeIds} compareMode={compareMode} />}
        {tab === 'subtypeBreakdown' && <ActivitySubtypeBreakdown teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} subtypeIds={subtypeIds} compareMode={compareMode} />}
        {tab === 'burn' && <AccountBurn teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} acv={acvFilter} stages={stageFilter} forecast={forecastFilter} compareMode={compareMode} />}
        {tab === 'capacityTrend' && <CapacityTrend teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} includeNonActivities={includeNonActivities} />}
        {tab === 'thisWeek' && <ThisWeekCapacity teamId={scopeTeamId} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} includeNonActivities={includeNonActivities} />}
        {tab === 'planVsActual' && <PlanVsActual teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} />}
        {tab === 'compliance' && <LoggingCompliance teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} />}
        {tab === 'lag' && <LoggingLag teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} />}
        {tab === 'mix' && <ActivityMix teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} subtypeIds={subtypeIds} compareMode={compareMode} />}
        {tab === 'concentration' && <AccountConcentration teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} acv={acvFilter} stages={stageFilter} forecast={forecastFilter} compareMode={compareMode} />}
        {tab === 'wow' && <WowDelta teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} />}
        {tab === 'productsBreakdown' && <ProductsBreakdown teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} compareMode={compareMode} />}
        {tab === 'oppRoi' && <OpportunityRoiScatter teamId={scopeTeamId} weeksBack={effectiveWeeksBack} memberIds={effectiveMemberIds} acv={acvFilter} stages={stageFilter} forecast={forecastFilter} productIds={productIds} />}
        {tab === 'costPerAcv' && <CostPerAcv teamId={scopeTeamId} weeksBack={effectiveWeeksBack} memberIds={effectiveMemberIds} acv={acvFilter} stages={stageFilter} forecast={forecastFilter} productIds={productIds} />}
        {tab === 'managerRollup' && <ManagerRollup weeksBack={effectiveWeeksBack} acv={acvFilter} productIds={productIds} stages={stageFilter} forecast={forecastFilter} memberIds={effectiveMemberIds.length > 0 ? effectiveMemberIds : undefined} />}
        {tab === 'sales_team_breakdown' && <SalesTeamBreakdown teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} acv={acvFilter} stages={stageFilter} forecast={forecastFilter} memberIds={effectiveMemberIds.length > 0 ? effectiveMemberIds : undefined} />}
        {tab === 'mostExpensive' && <MostExpensive weeksBack={effectiveWeeksBack} stages={stageFilter} forecast={forecastFilter} acv={acvFilter} productIds={productIds} memberIds={effectiveMemberIds.length > 0 ? effectiveMemberIds : undefined} />}
        {tab === 'userLeaderboard' && <UserLeaderboard weeksBack={effectiveWeeksBack} stages={stageFilter} forecast={forecastFilter} acv={acvFilter} productIds={productIds} memberIds={effectiveMemberIds.length > 0 ? effectiveMemberIds : undefined} />}
        {/* Deep Dive's subteam/member params are a structural roster-narrowing
            axis (AND'd together — see the component's own prop comments),
            not the generic union filter the other tabs use. Pass the raw
            checked subteams + individually-picked people, not the
            subteam-expanded effectiveMemberIds, so a person picked outside
            a checked subteam isn't silently AND'd out of the tree. */}
        {tab === 'teamActivityDeepDive' && <TeamActivityDeepDive teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} subteamIds={subteamIds} memberIds={userIds} subtypeIds={subtypeIds} stages={stageFilter} forecast={forecastFilter} acv={acvFilter} />}
        {tab === 'wonWithoutPoc' && <WonWithoutPoc teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} stages={stageFilter} forecast={forecastFilter} acv={acvFilter} />}
        {tab === 'closedLostReview' && <ClosedLostReview teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} stages={stageFilter} forecast={forecastFilter} acv={acvFilter} />}
        {tab === 'projectCosting' && <ProjectCosting teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds.length > 0 ? effectiveMemberIds : undefined} stages={stageFilter} forecast={forecastFilter} acv={acvFilter} />}
        {tab === 'historyOverview' && <HistoryDashboard teamId={scopeTeamId} />}
        {tab === 'sfDisconnected' && <SfDisconnected teamId={scopeTeamId} memberIds={effectiveMemberIds} />}
        {tab === 'outlookDisconnected' && <OutlookDisconnected teamId={scopeTeamId} memberIds={effectiveMemberIds} />}
        {tab === 'aiAssessments' && <AiAssessmentScores teamId={scopeTeamId} weeksBack={effectiveWeeksBack} productIds={productIds} memberIds={effectiveMemberIds} />}
        {tab === 'attachRate' && <AttachRate teamId={scopeTeamId} weeksBack={effectiveWeeksBack} memberIds={effectiveMemberIds.length > 0 ? effectiveMemberIds : undefined} stages={stageFilter} forecast={forecastFilter} acv={acvFilter} productIds={productIds} compareMode={compareMode} />}
      </div>
    </div>
    </DisplayCurrencyProvider>
  )
}
