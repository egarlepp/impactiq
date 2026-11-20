import { useState, useEffect, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, History, CheckCircle2, XCircle, RefreshCw } from 'lucide-react'
import { SyncIssues } from './SyncIssues.js'
import { SyncHistory } from './SyncHistory.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.216.0: single page for Salesforce write-back health, replacing the
// separate Sync Issues and Sync History screens.
//
// They were always two halves of one question — "is write-back working, and
// if not, what happened?" — and splitting them meant an admin triaging a
// failure had to leave the page to see whether it was a one-off or a pattern.
// The KPI row answers that at a glance; the two panes below are the original
// screens, unchanged, so nothing an admin relied on has moved or disappeared.

type View = 'issues' | 'history'

interface HistoryRow {
  status: string
  attemptedAt: string
}

// v1.261.0: only the field this component's own KPI math needs — the full
// shape lives in SyncIssues.tsx.
interface IssueRow {
  resolved: boolean
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  tone: 'good' | 'warn' | 'bad' | 'info'
}) {
  const TONE = {
    good: 'border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-100',
    warn: 'border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100',
    bad: 'border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/25 dark:text-rose-100',
    info: 'border-gray-200 bg-gray-50/60 text-gray-900 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-100',
  }[tone]
  const CHIP = {
    good: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300',
    bad: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300',
    info: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  }[tone]
  return (
    <div className={cn('relative overflow-hidden rounded-lg border p-3', TONE)}>
      <Icon className="pointer-events-none absolute -right-2 -top-2 h-16 w-16 opacity-10" />
      <div className="relative">
        <div className={cn('mb-1 inline-flex rounded-md p-1.5', CHIP)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <p className="text-[11px] uppercase tracking-wide opacity-75">{label}</p>
        <p className="text-xl font-semibold">{value}</p>
      </div>
    </div>
  )
}

export function CrmSync() {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [view, setView] = useState<View>('issues')
  const [openIssues, setOpenIssues] = useState<number | null>(null)
  const [resolvedIssues, setResolvedIssues] = useState<number | null>(null)
  const [recent, setRecent] = useState<HistoryRow[] | null>(null)

  // Summary only — each pane still owns its own data. Cheap enough to refetch
  // alongside a pane switch, and it means the header never lies after a retry.
  const loadSummary = async () => {
    const [issues, history] = await Promise.all([
      api.get<IssueRow[]>('/api/admin/sync-issues').catch(() => ({ data: [] })),
      api.get<HistoryRow[]>('/api/admin/sync-history?limit=500').catch(() => ({ data: [] })),
    ])
    const issueRows = issues.data ?? []
    setOpenIssues(issueRows.filter((r) => !r.resolved).length)
    setResolvedIssues(issueRows.filter((r) => r.resolved).length)
    setRecent((history.data as HistoryRow[]) ?? [])
  }
  useEffect(() => {
    void loadSummary()
  }, [])

  const last24 = (recent ?? []).filter(
    (r) => Date.now() - new Date(r.attemptedAt).getTime() < 24 * 60 * 60 * 1000,
  )
  const ok24 = last24.filter((r) => r.status === 'success').length
  const failed24 = last24.length - ok24
  const successRate = last24.length > 0 ? Math.round((ok24 / last24.length) * 100) : null

  const TABS: Array<{ key: View; label: string; icon: ComponentType<{ className?: string }> }> = [
    { key: 'issues', label: t('admin.crm_sync.tab_issues'), icon: AlertTriangle },
    { key: 'history', label: t('admin.crm_sync.tab_history'), icon: History },
  ]

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.crm_sync.description', { context: crmCtx })}</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={AlertTriangle}
          label={t('admin.crm_sync.kpi_open_resolved_issues', 'Open/Resolved Issues')}
          value={openIssues == null || resolvedIssues == null ? '—' : `${openIssues}/${resolvedIssues}`}
          tone={openIssues == null ? 'info' : openIssues > 0 ? 'bad' : 'good'}
        />
        <StatCard
          icon={RefreshCw}
          label={t('admin.crm_sync.kpi_attempts_24h')}
          value={recent == null ? '—' : String(last24.length)}
          tone="info"
        />
        <StatCard
          icon={CheckCircle2}
          label={t('admin.crm_sync.kpi_success_rate')}
          value={successRate == null ? '—' : `${successRate}%`}
          tone={successRate == null ? 'info' : successRate >= 95 ? 'good' : successRate >= 80 ? 'warn' : 'bad'}
        />
        <StatCard
          icon={XCircle}
          label={t('admin.crm_sync.kpi_failed_24h')}
          value={recent == null ? '—' : String(failed24)}
          tone={failed24 === 0 ? 'good' : failed24 > 10 ? 'bad' : 'warn'}
        />
      </div>

      <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5 text-xs dark:border-gray-700 dark:bg-gray-900">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = view === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => {
                setView(tab.key)
                void loadSummary()
              }}
              className={cn(
                'flex items-center gap-1 rounded px-3 py-1',
                active
                  ? 'bg-blue-600 font-medium text-white'
                  : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800',
              )}
            >
              <Icon className="h-3 w-3" />
              {tab.label}
              {tab.key === 'issues' && !!openIssues && (
                <span className={cn('ml-1 rounded-full px-1.5 text-[10px]', active ? 'bg-white/20' : 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300')}>
                  {openIssues}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {view === 'issues' ? <SyncIssues onChanged={loadSummary} /> : <SyncHistory />}
    </div>
  )
}
