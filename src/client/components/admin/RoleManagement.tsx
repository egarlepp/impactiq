import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Save as SaveIcon, Expand, Minimize } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

type Role = 'contributor' | 'leader' | 'team_admin'

interface PermissionRow {
  role: Role
  pageKey: string
  hasAccess: boolean
}

interface PageLeaf { key: string; labelKey: string }
interface PageCategory { key: string; labelKey: string; pages: PageLeaf[] }
interface PageGroup {
  key: string
  labelKey: string
  categories?: PageCategory[]
  pages?: PageLeaf[]
}

// Mirrors the app's actual navigation, in the same order: the sidebar's
// top-level links, then the Dashboard tabs in their on-screen group order,
// then every Admin section grouped exactly as the Admin sidebar groups them.
// When a page moves or is added anywhere in the app, it has to move here too —
// a permission matrix that doesn't match the menu is worse than none, because
// an admin will grant one thing believing they granted another.
const PAGE_TREE: PageGroup[] = [
  {
    key: 'activities',
    labelKey: 'admin.role_mgmt.page.activities',
    pages: [
      { key: 'activities', labelKey: 'admin.role_mgmt.page.activities' },
      { key: 'activities.transcripts', labelKey: 'admin.role_mgmt.page.activities_transcripts' },
      { key: 'activities.ai_notes', labelKey: 'admin.role_mgmt.page.activities_ai_notes' },
      { key: 'activities.ai_assessments', labelKey: 'admin.role_mgmt.page.activities_ai_assessments' },
    ],
  },
  {
    key: 'dashboard',
    labelKey: 'admin.role_mgmt.page.dashboard',
    categories: [
      {
        key: 'capacity',
        labelKey: 'leader.group.capacity',
        pages: [
          { key: 'dashboard.heatmap', labelKey: 'admin.role_mgmt.page.dashboard_team_heatmap' },
          { key: 'dashboard.thisWeek', labelKey: 'admin.role_mgmt.page.dashboard_this_week' },
          { key: 'dashboard.capacityTrend', labelKey: 'admin.role_mgmt.page.dashboard_capacity_trend' },
        ],
      },
      {
        key: 'activity',
        labelKey: 'leader.group.activity',
        pages: [
          { key: 'dashboard.breakdown', labelKey: 'admin.role_mgmt.page.dashboard_activity_breakdown' },
          { key: 'dashboard.subtypeBreakdown', labelKey: 'admin.role_mgmt.page.dashboard_subtype_breakdown' },
          { key: 'dashboard.mix', labelKey: 'admin.role_mgmt.page.dashboard_mix' },
          { key: 'dashboard.planVsActual', labelKey: 'admin.role_mgmt.page.dashboard_plan_vs_actual' },
          { key: 'dashboard.sfDisconnected', labelKey: 'admin.role_mgmt.page.dashboard_sf_disconnected' },
          { key: 'dashboard.outlookDisconnected', labelKey: 'admin.role_mgmt.page.dashboard_outlook_disconnected' },
        ],
      },
      {
        key: 'accounts',
        labelKey: 'leader.group.accounts',
        pages: [
          { key: 'dashboard.burn', labelKey: 'admin.role_mgmt.page.dashboard_account_burn' },
          { key: 'dashboard.concentration', labelKey: 'admin.role_mgmt.page.dashboard_concentration' },
          { key: 'dashboard.mostExpensive', labelKey: 'admin.role_mgmt.page.dashboard_most_expensive' },
        ],
      },
      {
        key: 'health',
        labelKey: 'leader.group.health',
        pages: [
          { key: 'dashboard.compliance', labelKey: 'admin.role_mgmt.page.dashboard_compliance' },
          { key: 'dashboard.lag', labelKey: 'admin.role_mgmt.page.dashboard_lag' },
          { key: 'dashboard.wow', labelKey: 'admin.role_mgmt.page.dashboard_wow' },
          { key: 'dashboard.aiAssessments', labelKey: 'admin.role_mgmt.page.dashboard_ai_assessments' },
        ],
      },
      {
        key: 'products',
        labelKey: 'leader.group.products',
        pages: [
          { key: 'dashboard.productsBreakdown', labelKey: 'admin.role_mgmt.page.dashboard_products_breakdown' },
        ],
      },
      {
        key: 'revenue',
        labelKey: 'leader.group.revenue',
        pages: [
          { key: 'dashboard.oppRoi', labelKey: 'admin.role_mgmt.page.dashboard_opp_roi' },
          { key: 'dashboard.costPerAcv', labelKey: 'admin.role_mgmt.page.dashboard_cost_per_acv' },
        ],
      },
      {
        key: 'manager',
        labelKey: 'leader.group.manager',
        pages: [
          { key: 'dashboard.managerRollup', labelKey: 'admin.role_mgmt.page.dashboard_manager_rollup' },
          { key: 'dashboard.sales_team_breakdown', labelKey: 'admin.role_mgmt.page.dashboard_sales_team_breakdown' },
          { key: 'dashboard.userLeaderboard', labelKey: 'admin.role_mgmt.page.dashboard_user_leaderboard' },
          { key: 'dashboard.teamActivityDeepDive', labelKey: 'admin.role_mgmt.page.dashboard_team_activity_deep_dive' },
          { key: 'dashboard.wonWithoutPoc', labelKey: 'admin.role_mgmt.page.dashboard_won_without_poc' },
          { key: 'dashboard.closedLostReview', labelKey: 'admin.role_mgmt.page.dashboard_closed_lost_review' },
        ],
      },
      {
        key: 'infrastructure',
        labelKey: 'leader.group.infrastructure',
        pages: [
          { key: 'dashboard.projectCosting', labelKey: 'admin.role_mgmt.page.dashboard_project_costing' },
        ],
      },
      {
        key: 'coverage',
        labelKey: 'leader.group.coverage',
        pages: [
          { key: 'dashboard.attachRate', labelKey: 'admin.role_mgmt.page.dashboard_attach_rate' },
        ],
      },
      {
        key: 'history',
        labelKey: 'leader.group.history',
        pages: [
          { key: 'dashboard.historyOverview', labelKey: 'admin.role_mgmt.page.dashboard_history_overview' },
        ],
      },
    ],
  },
  {
    key: 'scheduling',
    labelKey: 'admin.role_mgmt.page.scheduling',
    pages: [{ key: 'scheduling', labelKey: 'admin.role_mgmt.page.scheduling' }],
  },
  {
    key: 'notes',
    labelKey: 'admin.role_mgmt.page.notes',
    pages: [{ key: 'notes', labelKey: 'admin.role_mgmt.page.notes' }],
  },
  {
    key: 'my_history',
    labelKey: 'admin.role_mgmt.page.my_history',
    pages: [{ key: 'my_history', labelKey: 'admin.role_mgmt.page.my_history' }],
  },
  {
    key: 'settings',
    labelKey: 'admin.role_mgmt.page.settings',
    pages: [{ key: 'settings', labelKey: 'admin.role_mgmt.page.settings' }],
  },
  {
    key: 'guide',
    labelKey: 'admin.role_mgmt.page.guide',
    pages: [{ key: 'guide', labelKey: 'admin.role_mgmt.page.guide' }],
  },
  {
    key: 'admin',
    labelKey: 'admin.role_mgmt.page.admin',
    categories: [
      {
        key: 'activities',
        labelKey: 'admin.categories.activities',
        pages: [
          { key: 'admin.activity_types', labelKey: 'admin.role_mgmt.page.admin_activity_types' },
          { key: 'admin.keyword_rules', labelKey: 'admin.role_mgmt.page.admin_keyword_rules' },
          { key: 'admin.nudge_rules', labelKey: 'admin.role_mgmt.page.admin_nudge_rules' },
          { key: 'admin.sf_mappings', labelKey: 'admin.role_mgmt.page.admin_sf_mappings' },
          { key: 'admin.activities_import', labelKey: 'admin.role_mgmt.page.admin_activities_import' },
          { key: 'admin.activity_templates', labelKey: 'admin.role_mgmt.page.admin_activity_templates' },
        ],
      },
      {
        key: 'people',
        labelKey: 'admin.categories.people',
        pages: [
          { key: 'admin.teams', labelKey: 'admin.role_mgmt.page.admin_teams' },
          { key: 'admin.users', labelKey: 'admin.role_mgmt.page.admin_users' },
          { key: 'admin.role_management', labelKey: 'admin.role_mgmt.page.admin_role_management' },
          { key: 'admin.capacity', labelKey: 'admin.role_mgmt.page.admin_capacity' },
          { key: 'admin.cost_groups', labelKey: 'admin.role_mgmt.page.admin_cost_groups' },
          { key: 'admin.sales_team_alignment', labelKey: 'admin.role_mgmt.page.admin_sales_team_alignment' },
        ],
      },
      {
        key: 'workplace',
        labelKey: 'admin.categories.workplace',
        pages: [
          { key: 'admin.calendars', labelKey: 'admin.role_mgmt.page.admin_calendars' },
          { key: 'admin.products', labelKey: 'admin.role_mgmt.page.admin_products' },
          { key: 'admin.terminology', labelKey: 'admin.role_mgmt.page.admin_terminology' },
          { key: 'admin.flight_deck', labelKey: 'admin.role_mgmt.page.admin_flight_deck' },
          { key: 'admin.announcements', labelKey: 'admin.role_mgmt.page.admin_announcements' },
          { key: 'admin.ai_notes', labelKey: 'admin.role_mgmt.page.admin_ai_notes' },
        ],
      },
      {
        key: 'integrations',
        labelKey: 'admin.categories.integrations',
        pages: [
          { key: 'admin.integrations', labelKey: 'admin.role_mgmt.page.admin_integrations' },
          { key: 'admin.ai_assistant', labelKey: 'admin.role_mgmt.page.admin_ai_assistant' },
          { key: 'admin.event_webhooks', labelKey: 'admin.role_mgmt.page.admin_event_webhooks' },
          { key: 'admin.email_communications', labelKey: 'admin.role_mgmt.page.admin_email_communications' },
          { key: 'admin.mcp_server', labelKey: 'admin.role_mgmt.page.admin_mcp_server' },
          { key: 'admin.historical_import', labelKey: 'admin.role_mgmt.page.admin_historical_import' },
        ],
      },
      {
        key: 'appearance',
        labelKey: 'admin.categories.appearance',
        pages: [
          { key: 'admin.themes', labelKey: 'admin.role_mgmt.page.admin_themes' },
        ],
      },
      {
        key: 'monitoring',
        labelKey: 'admin.categories.monitoring',
        pages: [
          { key: 'admin.db_health', labelKey: 'admin.role_mgmt.page.admin_db_health' },
          { key: 'admin.audit_log', labelKey: 'admin.role_mgmt.page.admin_audit_log' },
          { key: 'admin.login_history', labelKey: 'admin.role_mgmt.page.admin_login_history' },
          { key: 'admin.crm_sync', labelKey: 'admin.role_mgmt.page.admin_crm_sync' },
          { key: 'admin.nudge_history', labelKey: 'admin.role_mgmt.page.admin_nudge_history' },
          { key: 'admin.activity_health', labelKey: 'admin.role_mgmt.page.admin_activity_health' },
          { key: 'admin.scheduling', labelKey: 'admin.role_mgmt.page.admin_scheduling' },
        ],
      },
      {
        key: 'demo',
        labelKey: 'admin.categories.demo',
        pages: [
          { key: 'admin.demo_data', labelKey: 'admin.role_mgmt.page.admin_demo_data' },
        ],
      },
    ],
  },
]

const ROLES: Role[] = ['contributor', 'leader', 'team_admin']

function collectLeaves(group: PageGroup): PageLeaf[] {
  const out: PageLeaf[] = []
  if (group.pages) out.push(...group.pages)
  if (group.categories) for (const c of group.categories) out.push(...c.pages)
  return out
}
const ALL_LEAVES: PageLeaf[] = PAGE_TREE.flatMap(collectLeaves)
const ALL_KEYS: string[] = ALL_LEAVES.map((l) => l.key)

export function RoleManagement() {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [rows, setRows] = useState<PermissionRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // Set of open <details> ids. Empty = everything collapsed (the default).
  const [openSet, setOpenSet] = useState<Set<string>>(new Set())

  const allDetailIds = useMemo(() => {
    const ids: string[] = []
    for (const g of PAGE_TREE) {
      ids.push(`g:${g.key}`)
      if (g.categories) for (const c of g.categories) ids.push(`c:${g.key}:${c.key}`)
    }
    return ids
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await api.get<PermissionRow[]>('/api/admin/role-permissions')
      if (cancelled) return
      setRows(res.data ?? [])
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [])

  function hasAccess(role: Role, pageKey: string): boolean {
    return rows.some((r) => r.role === role && r.pageKey === pageKey && r.hasAccess)
  }

  function setAccess(role: Role, pageKey: string, next: boolean) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.role === role && r.pageKey === pageKey)
      if (idx >= 0) return prev.map((r, i) => (i === idx ? { ...r, hasAccess: next } : r))
      return [...prev, { role, pageKey, hasAccess: next }]
    })
  }

  function toggleDetail(id: string, open: boolean) {
    setOpenSet((prev) => {
      const n = new Set(prev)
      if (open) n.add(id); else n.delete(id)
      return n
    })
  }

  function expandAll() { setOpenSet(new Set(allDetailIds)) }
  function collapseAll() { setOpenSet(new Set()) }

  async function save() {
    setSaving(true); setErr(null)
    const payload: PermissionRow[] = []
    for (const role of ROLES) {
      for (const k of ALL_KEYS) payload.push({ role, pageKey: k, hasAccess: hasAccess(role, k) })
    }
    const res = await api.put('/api/admin/role-permissions', { permissions: payload })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    setSavedAt(performance.now())
  }

  if (!loaded) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  function grantedCount(role: Role, leaves: PageLeaf[]): number {
    return leaves.filter((l) => hasAccess(role, l.key)).length
  }

  function summaryText(leaves: PageLeaf[]): string {
    const total = leaves.length
    return ROLES.map((r) => t('admin.role_mgmt.count_summary', {
      granted: grantedCount(r, leaves),
      total,
      role: t(`admin.users.role_${r}`),
    })).join(' · ')
  }

  function renderLeafRow(leaf: PageLeaf, depth: number): React.ReactNode {
    return (
      <tr key={leaf.key} className="border-t border-gray-100 dark:border-gray-800">
        <td className="px-3 py-2" style={{ paddingLeft: 12 + depth * 16 }}>
          <span className="text-gray-700 dark:text-gray-300">{t(leaf.labelKey, { context: crmCtx })}</span>
        </td>
        {ROLES.map((role) => (
          <td key={role} className="px-3 py-2 text-center">
            <input
              type="checkbox"
              checked={hasAccess(role, leaf.key)}
              onChange={(e) => setAccess(role, leaf.key, e.target.checked)}
              className="h-4 w-4 cursor-pointer"
            />
          </td>
        ))}
        <td className="px-3 py-2 text-center text-amber-600 dark:text-amber-400">
          <input type="checkbox" checked disabled className="h-4 w-4 cursor-not-allowed opacity-50" />
        </td>
      </tr>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('admin.role_mgmt.intro')}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={expandAll} title={t('activity.expand_all')}>
          <Expand className="mr-1 h-3.5 w-3.5" />{t('activity.expand_all')}
        </Button>
        <Button size="sm" variant="outline" onClick={collapseAll} title={t('activity.collapse_all')}>
          <Minimize className="mr-1 h-3.5 w-3.5" />{t('activity.collapse_all')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {PAGE_TREE.map((group) => {
          const groupId = `g:${group.key}`
          const groupLeaves = collectLeaves(group)
          return (
            <details
              key={group.key}
              open={openSet.has(groupId)}
              onToggle={(e) => toggleDetail(groupId, (e.target as HTMLDetailsElement).open)}
              className="rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
            >
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800/50">
                <span>{t(group.labelKey)}</span>
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">— {summaryText(groupLeaves)}</span>
              </summary>
              <div className="border-t border-gray-200 dark:border-gray-700">
                <table className="min-w-full text-sm text-gray-900 dark:text-gray-100">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400">
                      <th className="px-3 py-2">{t('admin.role_mgmt.col_page')}</th>
                      <th className="px-3 py-2 text-center">{t('admin.users.role_contributor')}</th>
                      <th className="px-3 py-2 text-center">{t('admin.users.role_leader')}</th>
                      <th className="px-3 py-2 text-center">{t('admin.users.role_team_admin')}</th>
                      <th className="px-3 py-2 text-center text-amber-600 dark:text-amber-400">{t('admin.users.role_admin')}</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-900 dark:text-gray-100">
                    {group.pages && group.pages.map((leaf) => renderLeafRow(leaf, 0))}
                    {group.categories && group.categories.map((cat) => {
                      const catId = `c:${group.key}:${cat.key}`
                      return (
                        <React.Fragment key={cat.key}>
                          <tr className="border-t border-gray-200 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800/30">
                            <td colSpan={5} className="px-3 py-0">
                              <details
                                open={openSet.has(catId)}
                                onToggle={(e) => toggleDetail(catId, (e.target as HTMLDetailsElement).open)}
                              >
                                <summary className="cursor-pointer select-none py-2 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                                  {t(cat.labelKey)}
                                  <span className="ml-2 text-xs font-normal normal-case tracking-normal text-gray-500 dark:text-gray-400">— {summaryText(cat.pages)}</span>
                                </summary>
                              </details>
                            </td>
                          </tr>
                          {openSet.has(catId) && cat.pages.map((leaf) => renderLeafRow(leaf, 1))}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          )
        })}
      </div>

      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}{t('common.save')}
        </Button>
        {savedAt && <span className="text-xs text-green-600 dark:text-green-400">{t('common.saved')}</span>}
      </div>
    </div>
  )
}
