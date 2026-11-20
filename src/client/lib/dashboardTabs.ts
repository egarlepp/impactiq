import { hasPermission, type CurrentUser } from '../hooks/useCurrentUser.js'

// The leader dashboards and their groups, shared by the Dashboard page's
// picker and the header's global search so both list the same dashboards
// under the same Role Management keys (`dashboard.<tab>`).

export type DashboardTab =
  | 'heatmap' | 'breakdown' | 'subtypeBreakdown' | 'burn'
  | 'capacityTrend' | 'thisWeek' | 'planVsActual'
  | 'compliance' | 'lag' | 'mix' | 'concentration' | 'wow'
  | 'productsBreakdown'
  | 'oppRoi' | 'costPerAcv'
  | 'managerRollup'
  | 'sales_team_breakdown'
  | 'mostExpensive'
  | 'userLeaderboard'
  | 'teamActivityDeepDive'
  | 'wonWithoutPoc'
  | 'closedLostReview'
  | 'projectCosting'
  | 'attachRate'
  | 'historyOverview'
  | 'sfDisconnected'
  | 'outlookDisconnected'
  | 'aiAssessments'

export interface DashboardTabGroup {
  groupKey: string
  // Unicode symbol shown before the group label in the native <select>
  // optgroup (React icons can't render inside native select markup, so a
  // glyph is the best portable approximation).
  glyph: string
  tabs: { key: DashboardTab; labelKey: string }[]
}

export const DASHBOARD_GROUPS: DashboardTabGroup[] = [
  {
    groupKey: 'leader.group.capacity',
    glyph: '⚡',
    tabs: [
      { key: 'heatmap', labelKey: 'leader.heatmap.title' },
      { key: 'thisWeek', labelKey: 'leader.this_week.title' },
      { key: 'capacityTrend', labelKey: 'leader.capacity_trend.title' },
    ],
  },
  {
    groupKey: 'leader.group.activity',
    glyph: '📊',
    tabs: [
      { key: 'breakdown', labelKey: 'leader.breakdown.title' },
      { key: 'subtypeBreakdown', labelKey: 'leader.subtype_breakdown.title' },
      { key: 'mix', labelKey: 'leader.mix.title' },
      { key: 'planVsActual', labelKey: 'leader.plan_vs_actual.title' },
      { key: 'sfDisconnected', labelKey: 'leader.sf_disconnected.title' },
      { key: 'outlookDisconnected', labelKey: 'leader.outlook_disconnected.title' },
    ],
  },
  {
    groupKey: 'leader.group.accounts',
    glyph: '💼',
    tabs: [
      { key: 'burn', labelKey: 'leader.burn.title' },
      { key: 'concentration', labelKey: 'leader.concentration.title' },
      { key: 'mostExpensive', labelKey: 'leader.most_expensive.title' },
    ],
  },
  {
    groupKey: 'leader.group.health',
    glyph: '❤',
    tabs: [
      { key: 'compliance', labelKey: 'leader.compliance.title' },
      { key: 'lag', labelKey: 'leader.lag.title' },
      { key: 'wow', labelKey: 'leader.wow.title' },
      { key: 'aiAssessments', labelKey: 'leader.ai_assessments.title' },
    ],
  },
  {
    groupKey: 'leader.group.products',
    glyph: '📦',
    tabs: [
      { key: 'productsBreakdown', labelKey: 'leader.products_breakdown.title' },
    ],
  },
  {
    groupKey: 'leader.group.revenue',
    glyph: '💰',
    tabs: [
      { key: 'oppRoi', labelKey: 'leader.opp_roi.title' },
      { key: 'costPerAcv', labelKey: 'leader.cost_per_acv.title' },
    ],
  },
  {
    groupKey: 'leader.group.manager',
    glyph: '🏢',
    tabs: [
      { key: 'managerRollup', labelKey: 'leader.manager_rollup.title' },
      { key: 'sales_team_breakdown', labelKey: 'leader.sales_team_breakdown.title' },
      { key: 'userLeaderboard', labelKey: 'leader.user_leaderboard.title' },
      { key: 'teamActivityDeepDive', labelKey: 'leader.team_activity_deep_dive.title' },
      { key: 'wonWithoutPoc', labelKey: 'leader.won_without_poc.title' },
      { key: 'closedLostReview', labelKey: 'leader.closed_lost_review.title' },
    ],
  },
  {
    groupKey: 'leader.group.infrastructure',
    glyph: '🏗',
    tabs: [
      { key: 'projectCosting', labelKey: 'leader.project_costing.title' },
    ],
  },
  {
    groupKey: 'leader.group.coverage',
    glyph: '🔗',
    tabs: [
      { key: 'attachRate', labelKey: 'leader.attach_rate.title' },
    ],
  },
  // v1.214.0: pre-ImpactIQ Salesforce history. Kept in its own group and
  // fully separate from the live capacity/cost dashboards above — its hours
  // are estimates from SF scheduled meeting length, not logged effort.
  {
    groupKey: 'leader.group.history',
    glyph: '🕰',
    tabs: [
      { key: 'historyOverview', labelKey: 'leader.history.title' },
    ],
  },
]

// v1.387.0: dashboards built on Projects, hidden when an App Admin turns
// Projects off (Admin → Integrations → Projects). Their routes answer 409
// then too, so hiding is never the only guard.
export const PROJECT_TABS = new Set<string>(['wonWithoutPoc', 'projectCosting'])

export function isDashboardTab(value: string | null | undefined): value is DashboardTab {
  return !!value && DASHBOARD_GROUPS.some((g) => g.tabs.some((tt) => tt.key === value))
}

// The groups and dashboards this user can open: each dashboard's own grant,
// and the Projects switch for the Projects dashboards. Callers outside the
// Dashboard page also check the page's own `dashboard` key.
export function visibleDashboardGroups(user: CurrentUser | null, projectsOn: boolean): DashboardTabGroup[] {
  return DASHBOARD_GROUPS.map((g) => ({
    ...g,
    tabs: g.tabs.filter((tt) => hasPermission(user, `dashboard.${tt.key}`) && (projectsOn || !PROJECT_TABS.has(tt.key))),
  })).filter((g) => g.tabs.length > 0)
}

export function dashboardHref(tab: DashboardTab): string {
  return `/dashboard?tab=${tab}`
}
