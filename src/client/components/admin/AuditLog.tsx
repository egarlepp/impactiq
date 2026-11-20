import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, Trash2, User, Users, Archive } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { Input } from '../ui/input.js'
import { Select } from '../ui/select.js'
import { Label } from '../ui/label.js'
import { SortableTh, TablePagination } from '../ui/table-controls.js'
import { useTableView } from '../../lib/tableView.js'
import { AUDIT_ACTIONS } from '../../../shared/auditActions.js'
import { cn } from '../../lib/utils.js'

interface AuditRow {
  id: string
  actorUserId: string | null
  actorEmail: string | null
  action: string
  targetType: string | null
  targetId: string | null
  targetName: string | null
  changedFields: string[]
  meta: Record<string, unknown> | null
  ip: string | null
  userAgent: string | null
  createdAt: string
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function AuditMetaBody({ meta }: { meta: Record<string, unknown> }) {
  const { t } = useTranslation()
  const before = meta['before'] as Record<string, unknown> | undefined
  const after = meta['after'] as Record<string, unknown> | undefined
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    if (keys.length === 0) {
      return <p className="mt-1 text-[10px] text-gray-400">{t('admin.audit.diff.empty', 'No field-level changes.')}</p>
    }
    return (
      <table className="mt-1 w-full text-[10px]">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400">
            <th className="pr-2 font-medium">{t('admin.audit.diff.col_field', 'Field')}</th>
            <th className="pr-2 font-medium">{t('admin.audit.diff.col_before', 'Before')}</th>
            <th className="font-medium">{t('admin.audit.diff.col_after', 'After')}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k} className="border-t border-gray-200 dark:border-gray-800">
              <td className="pr-2 py-0.5 font-mono">{humanizeField(k)}</td>
              <td className="pr-2 py-0.5 text-red-700 dark:text-red-400 break-all">{formatValue(before[k])}</td>
              <td className="py-0.5 text-emerald-700 dark:text-emerald-400 break-all">{formatValue(after[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <pre className="mt-1 max-w-md overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-2 text-[10px]">{JSON.stringify(meta, null, 2)}</pre>
  )
}

function humanizeField(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).trim()
}

// v1.330.0: same small bordered card used on CRM Sync / Nudge History /
// Login History. Duplicated locally rather than shared, matching this
// codebase's existing convention for this component.
function StatCard({
  icon: Icon,
  label,
  value,
  subLabel,
  subValue,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  subLabel?: string
  subValue?: string
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
        <p className="truncate text-xl font-semibold" title={value}>{value}</p>
        {subLabel && (
          <p className="mt-0.5 text-[11px] opacity-75">{subLabel}: <span className="font-medium">{subValue}</span></p>
        )}
      </div>
    </div>
  )
}

interface AuditSummary {
  totalEvents7d: number
  destructiveEvents7d: number
  topActor7d: { userId: string; name: string; count: number } | null
  distinctActors7d: number
  oldestEventAt: string | null
  retainedDays: number | null
  retentionDays: number
}

// v1.302.0: was a hand-maintained subset of the real action list and had
// drifted badly (17 of 47 real actions selectable) — now sourced from the
// same shared/auditActions.ts the server types every logAudit() call
// against, so a new action is filterable the moment it's added there.
const ACTION_OPTIONS: string[] = ['', ...AUDIT_ACTIONS]

// Fallback label when no translation exists — turn "role_permissions.update"
// into "Role permissions · update" so raw DB codes never leak into the UI.
function humanizeAction(action: string): string {
  return action
    .split('.')
    .map((part) => part.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))
    .join(' · ')
}

export function AuditLog() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [action, setAction] = useState('')
  const [actorEmail, setActorEmail] = useState('')
  const [summary, setSummary] = useState<AuditSummary | null>(null)

  useEffect(() => {
    void (async () => {
      setRows(null)
      const params = new URLSearchParams({ limit: '100' })
      if (action) params.set('action', action)
      const res = await api.get<AuditRow[]>(`/api/admin/audit?${params.toString()}`)
      let data = res.data ?? []
      if (actorEmail) {
        const q = actorEmail.toLowerCase()
        data = data.filter((r) => (r.actorEmail ?? '').toLowerCase().includes(q))
      }
      setRows(data)
    })()
  }, [action, actorEmail])

  // v1.330.0: the KPI row describes the audit log's overall recent/all-time
  // state, not whatever the Action/Actor filters above happen to be set to —
  // fetched once on load, independent of `rows`, same as CRM Sync's own
  // summary fetch.
  useEffect(() => {
    void api.get<AuditSummary>('/api/admin/audit/summary').then((res) => { if (res.data) setSummary(res.data) })
  }, [])

  const destructiveTone = summary == null ? 'info' : summary.destructiveEvents7d > 0 ? 'warn' : 'good'

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          icon={ListChecks}
          label={t('admin.audit.kpi_total_events', 'Total Events (7d)')}
          value={summary == null ? '—' : String(summary.totalEvents7d)}
          tone="info"
        />
        <StatCard
          icon={Trash2}
          label={t('admin.audit.kpi_destructive', 'Destructive Actions (7d)')}
          value={summary == null ? '—' : String(summary.destructiveEvents7d)}
          tone={destructiveTone}
        />
        <StatCard
          icon={User}
          label={t('admin.audit.kpi_top_actor', 'Most Active Admin (7d)')}
          value={summary?.topActor7d ? summary.topActor7d.name : t('admin.audit.kpi_no_activity', 'None')}
          subLabel={summary?.topActor7d ? t('admin.audit.kpi_count', 'Actions') : undefined}
          subValue={summary?.topActor7d ? String(summary.topActor7d.count) : undefined}
          tone="info"
        />
        <StatCard
          icon={Users}
          label={t('admin.audit.kpi_distinct_actors', 'Distinct Actors (7d)')}
          value={summary == null ? '—' : String(summary.distinctActors7d)}
          tone="info"
        />
        <StatCard
          icon={Archive}
          label={t('admin.audit.kpi_retention', 'Retention Horizon')}
          value={summary?.retainedDays == null ? '—' : t('admin.audit.kpi_days', '{{count}}d', { count: summary.retainedDays })}
          subLabel={summary?.retainedDays != null ? t('admin.audit.kpi_retention_limit', 'Limit') : undefined}
          subValue={summary?.retainedDays != null ? t('admin.audit.kpi_days', '{{count}}d', { count: summary.retentionDays }) : undefined}
          tone="info"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label>{t('admin.audit.action_filter')}</Label>
          <Select value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTION_OPTIONS.map((a) => (
              <option key={a || 'all'} value={a}>
                {a ? t(`admin.audit.actions.${a}`, humanizeAction(a)) : t('admin.audit.all_actions')}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.audit.actor_email_filter')}</Label>
          <Input value={actorEmail} onChange={(e) => setActorEmail(e.target.value)} placeholder="jane@..." />
        </div>
      </div>
      {!rows ? (
        <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.audit.empty')}</p>
      ) : (
        <AuditTable rows={rows} />
      )}
    </div>
  )
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  const { t } = useTranslation()
  const getters = useMemo(() => ({
    when: (r: AuditRow) => r.createdAt ?? '',
    actor: (r: AuditRow) => r.actorEmail ?? '',
    action: (r: AuditRow) => r.action ?? '',
    target: (r: AuditRow) => `${r.targetType ?? ''} ${r.targetName ?? ''} ${r.targetId ?? ''}`,
    changes: (r: AuditRow) => (r.changedFields ?? []).join(' '),
    ip: (r: AuditRow) => r.ip ?? '',
  }), [])
  const view = useTableView(rows, getters)
  const searchPh = t('common.search_placeholder')

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
      <div className="overflow-x-auto">
      <table className="w-full text-sm text-gray-900 dark:text-gray-100">
            <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <SortableTh label={t('admin.audit.when')} colKey="when" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
                <SortableTh label={t('admin.audit.actor')} colKey="actor" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.actor} onFilter={(v) => view.setFilter('actor', v)} filterPlaceholder={searchPh} />
                <SortableTh label={t('admin.audit.action_col')} colKey="action" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.action} onFilter={(v) => view.setFilter('action', v)} filterPlaceholder={searchPh} />
                <SortableTh label={t('admin.audit.target')} colKey="target" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.target} onFilter={(v) => view.setFilter('target', v)} filterPlaceholder={searchPh} />
                <SortableTh label={t('admin.audit.changes', 'Changes')} colKey="changes" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.changes} onFilter={(v) => view.setFilter('changes', v)} filterPlaceholder={searchPh} />
                <SortableTh label={t('admin.audit.ip')} colKey="ip" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.ip} onFilter={(v) => view.setFilter('ip', v)} filterPlaceholder={searchPh} />
              </tr>
            </thead>
            <tbody>
              {view.visible.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600 dark:text-gray-400">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{r.actorEmail ?? '—'}</td>
                  <td className="px-3 py-2 text-xs" title={r.action}>
                    {t(`admin.audit.actions.${r.action}`, humanizeAction(r.action))}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.targetType && (
                      <div className="flex items-baseline gap-1">
                        <span className="text-gray-500 dark:text-gray-400">{r.targetType}:</span>
                        <span className="font-medium text-gray-800 dark:text-gray-100">{r.targetName ?? r.targetId ?? '—'}</span>
                      </div>
                    )}
                    {!r.targetType && <span className="text-gray-400">—</span>}
                    {r.targetId && r.targetName && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-gray-400" title={r.targetId}>{r.targetId}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.changedFields.length > 0 ? (
                      <>
                        <div className="flex flex-wrap gap-1">
                          {r.changedFields.map((f) => (
                            <span key={f} className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{humanizeField(f)}</span>
                          ))}
                        </div>
                        {r.meta && Object.keys(r.meta).length > 0 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[10px] text-gray-500">{t('admin.audit.view_details', 'Details')}</summary>
                            <AuditMetaBody meta={r.meta} />
                          </details>
                        )}
                      </>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-gray-500 dark:text-gray-400">{r.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
      </div>
      <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
    </div>
  )
}
