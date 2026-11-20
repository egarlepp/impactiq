import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { LogOut, ShieldAlert, Percent, Eye, AlertTriangle, KeyRound, ShieldX } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { SortableTh, TablePagination } from '../ui/table-controls.js'
import { useTableView } from '../../lib/tableView.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'

interface Login {
  id: string
  userId: string | null
  email: string | null
  displayName: string | null
  attemptedEmail: string | null
  success: boolean
  failureReason: string | null
  method: string
  ip: string | null
  userAgent: string | null
  isSuspicious: boolean
  alertSentAt: string | null
  createdAt: string
}
interface Session { id: string; email: string; displayName: string; ip: string | null; userAgent: string | null; createdAt: string; lastUsedAt: string; expiresAt: string; mfaMethod: string | null }
interface Payload { logins: Login[]; sessions: Session[] }

// v1.330.0: same small bordered card used on CRM Sync / Nudge History.
// Duplicated locally rather than shared — matches this codebase's existing
// convention (NudgeHistory.tsx has its own copy too).
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

// Login-completion methods only ever land here as 'okta'/'azure' (SSO) or
// 'mfa'/'totp'/'backup_code' (password path — MFA is required on every
// password login in this app, so a successful password sign-in is NEVER
// tagged 'password' itself; that literal only appears on FAILED attempts,
// before MFA is reached). "Not SSO" is therefore the correct password-path
// test among successful events, not a check against the literal 'password'.
const SSO_METHODS = new Set(['okta', 'azure'])

function humanizeFailureReason(reason: string): string {
  return reason.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function useLoginKpis(logins: Login[] | null) {
  return useMemo(() => {
    if (!logins) return null
    const total = logins.length
    const failed = logins.filter((l) => !l.success)
    const failRatePct = total > 0 ? Math.round((failed.length / total) * 100) : null

    const suspicious = logins.filter((l) => l.isSuspicious)
    const suspiciousNoAlert = suspicious.filter((l) => !l.alertSentAt).length

    const reasonCounts = new Map<string, number>()
    for (const l of failed) {
      const reason = l.failureReason ?? 'other'
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    }
    let topReason: string | null = null
    let topReasonCount = 0
    for (const [reason, count] of reasonCounts) {
      if (count > topReasonCount) { topReason = reason; topReasonCount = count }
    }

    const successful = logins.filter((l) => l.success)
    const ssoCount = successful.filter((l) => SSO_METHODS.has(l.method)).length
    const ssoPct = successful.length > 0 ? Math.round((ssoCount / successful.length) * 100) : null

    const DAY_MS = 24 * 60 * 60 * 1000
    const now = Date.now()
    const recentFailedByAccount = new Map<string, number>()
    for (const l of failed) {
      if (now - new Date(l.createdAt).getTime() >= DAY_MS) continue
      const key = l.attemptedEmail ?? l.userId ?? 'unknown'
      recentFailedByAccount.set(key, (recentFailedByAccount.get(key) ?? 0) + 1)
    }
    const underAttackCount = Array.from(recentFailedByAccount.values()).filter((c) => c >= 3).length

    return {
      total, failedCount: failed.length, failRatePct,
      suspiciousCount: suspicious.length, suspiciousNoAlert,
      topReason, topReasonCount,
      ssoPct, successfulCount: successful.length,
      underAttackCount,
    }
  }, [logins])
}

export function LoginHistory() {
  const { t } = useTranslation()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'sessions' | 'logins' | 'failures'>('sessions')

  async function reload() {
    setError(null)
    // v1.330.0: bumped from 200 to the server's own max (500) so the new KPI
    // row has a large enough sample — matches CRM Sync's own limit=500 for
    // its 24h stats.
    const res = await api.get<Payload>('/api/admin/login-history?limit=500')
    if (res.error) { setError(res.error); setData({ logins: [], sessions: [] }); return }
    setData(res.data ?? { logins: [], sessions: [] })
  }
  useEffect(() => { void reload() }, [])
  const kpis = useLoginKpis(data?.logins ?? null)

  async function revoke(id: string) {
    if (!window.confirm(t('admin.login_history.revoke_confirm'))) return
    await api.delete(`/api/admin/sessions/${id}`)
    await reload()
  }

  if (!data) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (error) return <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{error}</div>

  const kpiFailRateTone = kpis?.failRatePct == null ? 'info' : kpis.failRatePct <= 5 ? 'good' : kpis.failRatePct <= 20 ? 'warn' : 'bad'
  const kpiSuspiciousTone = kpis == null ? 'info' : kpis.suspiciousCount > 0 ? 'warn' : 'good'
  const kpiTopReasonTone = kpis == null ? 'info' : kpis.topReasonCount > 0 ? 'warn' : 'good'
  const kpiAttackTone = kpis == null ? 'info' : kpis.underAttackCount > 0 ? 'bad' : 'good'

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('admin.login_history.hint', 'Active sessions are currently-valid sessions from successful sign-ins. Recent logins lists successful sign-in events. Failed attempts lists rejected login attempts.')}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          icon={Percent}
          label={t('admin.login_history.kpi_fail_rate', 'Failed Login Rate')}
          value={kpis?.failRatePct == null ? '—' : `${kpis.failRatePct}%`}
          tone={kpiFailRateTone}
        />
        <StatCard
          icon={Eye}
          label={t('admin.login_history.kpi_suspicious', 'Suspicious Logins')}
          value={kpis == null ? '—' : String(kpis.suspiciousCount)}
          subLabel={kpis && kpis.suspiciousNoAlert > 0 ? t('admin.login_history.kpi_alert_not_sent', 'Alert not sent') : undefined}
          subValue={kpis && kpis.suspiciousNoAlert > 0 ? String(kpis.suspiciousNoAlert) : undefined}
          tone={kpiSuspiciousTone}
        />
        <StatCard
          icon={AlertTriangle}
          label={t('admin.login_history.kpi_top_failure_reason', 'Top Failure Reason')}
          value={kpis == null ? '—' : kpis.topReason == null
            ? t('admin.login_history.kpi_no_failures', 'None')
            : t(`admin.login_history.failure.${kpis.topReason}`, humanizeFailureReason(kpis.topReason))}
          subLabel={kpis && kpis.topReason != null ? t('admin.login_history.kpi_count', 'Count') : undefined}
          subValue={kpis && kpis.topReason != null ? String(kpis.topReasonCount) : undefined}
          tone={kpiTopReasonTone}
        />
        <StatCard
          icon={KeyRound}
          label={t('admin.login_history.kpi_sso_split', 'SSO vs. Password')}
          value={kpis?.ssoPct == null ? '—' : `${kpis.ssoPct}% ${t('admin.login_history.kpi_sso', 'SSO')}`}
          subLabel={kpis?.ssoPct != null ? t('admin.login_history.kpi_password', 'Password') : undefined}
          subValue={kpis?.ssoPct != null ? `${100 - kpis.ssoPct}%` : undefined}
          tone="info"
        />
        <StatCard
          icon={ShieldX}
          label={t('admin.login_history.kpi_under_attack', 'Accounts Under Attack')}
          value={kpis == null ? '—' : String(kpis.underAttackCount)}
          tone={kpiAttackTone}
        />
      </div>

      <div className="inline-flex self-start rounded-md border border-gray-200 dark:border-gray-800 text-xs">
        <button onClick={() => setTab('sessions')} className={`px-3 py-1.5 ${tab === 'sessions' ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' : 'text-gray-600 dark:text-gray-400'}`}>
          {t('admin.login_history.tab_sessions', { count: data.sessions.length })}
        </button>
        <button onClick={() => setTab('logins')} className={`px-3 py-1.5 ${tab === 'logins' ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' : 'text-gray-600 dark:text-gray-400'}`}>
          {t('admin.login_history.tab_logins', { count: data.logins.filter((l) => l.success).length })}
        </button>
        <button onClick={() => setTab('failures')} className={`px-3 py-1.5 ${tab === 'failures' ? 'bg-red-600 text-white' : 'text-red-600 dark:text-red-400'}`}>
          {t('admin.login_history.tab_failures', { count: data.logins.filter((l) => !l.success).length, defaultValue: 'Failed attempts ({{count}})' })}
        </button>
      </div>

      {tab === 'sessions' && <SessionsTable rows={data.sessions} onRevoke={revoke} />}
      {(tab === 'logins' || tab === 'failures') && (
        <LoginsTable rows={data.logins.filter((l) => tab === 'logins' ? l.success : !l.success)} tab={tab} />
      )}
    </div>
  )
}

function SessionsTable({ rows, onRevoke }: { rows: Session[]; onRevoke: (id: string) => void }) {
  const { t } = useTranslation()
  const getters = useMemo(() => ({
    user: (s: Session) => `${s.displayName ?? ''} ${s.email ?? ''}`,
    ip: (s: Session) => s.ip ?? '',
    device: (s: Session) => s.userAgent ?? '',
    mfaMethod: (s: Session) => s.mfaMethod ?? '',
    lastUsed: (s: Session) => s.lastUsedAt ?? '',
    expires: (s: Session) => s.expiresAt ?? '',
  }), [])
  const view = useTableView(rows, getters)
  const searchPh = t('common.search_placeholder')

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
      <div className="overflow-x-auto">
      <table className="w-full text-sm text-gray-900 dark:text-gray-100">
        <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <tr>
            <SortableTh label={t('admin.login_history.user')} colKey="user" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.user} onFilter={(v) => view.setFilter('user', v)} filterPlaceholder={searchPh} />
            <SortableTh label={t('admin.login_history.ip')} colKey="ip" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.ip} onFilter={(v) => view.setFilter('ip', v)} filterPlaceholder={searchPh} />
            <SortableTh label={t('admin.login_history.device')} colKey="device" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.device} onFilter={(v) => view.setFilter('device', v)} filterPlaceholder={searchPh} />
            <SortableTh label={t('admin.login_history.method')} colKey="mfaMethod" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
            <SortableTh label={t('admin.login_history.last_used')} colKey="lastUsed" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
            <SortableTh label={t('admin.login_history.expires')} colKey="expires" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
            <th />
          </tr>
        </thead>
        <tbody>
          {view.visible.map((s) => (
            <tr key={s.id} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
              <td className="px-3 py-2">
                <div>{s.displayName}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{s.email}</div>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{s.ip ?? '—'}</td>
              <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{s.userAgent?.slice(0, 60) ?? '—'}</td>
              <td className="px-3 py-2 text-xs">
                {s.mfaMethod
                  ? <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono uppercase text-gray-700 dark:bg-gray-800 dark:text-gray-300">{t(`admin.login_history.method_val.${s.mfaMethod}`, s.mfaMethod)}</span>
                  : <span className="text-gray-400">—</span>}
              </td>
              <td className="px-3 py-2 text-xs">{new Date(s.lastUsedAt).toLocaleString()}</td>
              <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{new Date(s.expiresAt).toLocaleString()}</td>
              <td className="px-3 py-2 text-right">
                <Button size="sm" variant="outline" onClick={() => onRevoke(s.id)}><LogOut className="mr-1 h-3 w-3" />{t('admin.login_history.revoke')}</Button>
              </td>
            </tr>
          ))}
          {view.total === 0 && <tr><td colSpan={7} className="py-6 text-center text-sm text-gray-400">{t('admin.login_history.empty_sessions')}</td></tr>}
        </tbody>
      </table>
      </div>
      <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
    </div>
  )
}

function LoginsTable({ rows, tab }: { rows: Login[]; tab: 'logins' | 'failures' }) {
  const { t } = useTranslation()
  const getters = useMemo(() => ({
    when: (l: Login) => l.createdAt ?? '',
    user: (l: Login) => `${l.displayName ?? ''} ${l.email ?? l.attemptedEmail ?? ''}`,
    method: (l: Login) => l.method ?? '',
    ip: (l: Login) => l.ip ?? '',
    status: (l: Login) => l.success ? (l.isSuspicious ? 'suspicious' : 'ok') : (l.failureReason ?? 'failed'),
  }), [])
  const view = useTableView(rows, getters, { resetKey: tab })
  const searchPh = t('common.search_placeholder')

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
      <div className="overflow-x-auto">
      <table className="w-full text-sm text-gray-900 dark:text-gray-100">
        <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <tr>
            <SortableTh label={t('admin.login_history.when')} colKey="when" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
            <SortableTh label={t('admin.login_history.user')} colKey="user" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.user} onFilter={(v) => view.setFilter('user', v)} filterPlaceholder={searchPh} />
            <SortableTh label={t('admin.login_history.method')} colKey="method" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.method} onFilter={(v) => view.setFilter('method', v)} filterPlaceholder={searchPh} />
            <SortableTh label={t('admin.login_history.ip')} colKey="ip" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.ip} onFilter={(v) => view.setFilter('ip', v)} filterPlaceholder={searchPh} />
            <SortableTh label={t('admin.login_history.status')} colKey="status" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.status} onFilter={(v) => view.setFilter('status', v)} filterPlaceholder={searchPh} />
          </tr>
        </thead>
        <tbody>
          {view.visible.map((l) => (
            <tr key={l.id} className={`border-b border-gray-100 dark:border-gray-900 last:border-b-0 ${!l.success ? 'bg-red-50/50 dark:bg-red-950/20' : l.isSuspicious ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''}`}>
              <td className="px-3 py-2 text-xs whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</td>
              <td className="px-3 py-2">
                <div>{l.displayName ?? <span className="italic text-gray-500">{t('admin.login_history.unknown_user', 'Unknown')}</span>}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{l.email ?? l.attemptedEmail ?? '—'}</div>
              </td>
              <td className="px-3 py-2 font-mono text-xs uppercase">{l.method}</td>
              <td className="px-3 py-2 font-mono text-xs">{l.ip ?? '—'}</td>
              <td className="px-3 py-2 text-xs">
                {!l.success ? (
                  <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
                    <ShieldAlert className="h-3 w-3" />
                    {t(`admin.login_history.failure.${l.failureReason ?? 'other'}`, l.failureReason ?? 'Failed')}
                  </span>
                ) : l.isSuspicious ? (
                  <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><ShieldAlert className="h-3 w-3" />{t('admin.login_history.new_ip')}</span>
                ) : <span className="text-gray-500">{t('admin.login_history.known')}</span>}
              </td>
            </tr>
          ))}
          {view.total === 0 && (
            <tr><td colSpan={5} className="py-6 text-center text-sm text-gray-400">
              {tab === 'failures' ? t('admin.login_history.empty_failures', 'No failed sign-in attempts recorded.') : t('admin.login_history.empty_logins')}
            </td></tr>
          )}
        </tbody>
      </table>
      </div>
      <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
    </div>
  )
}
