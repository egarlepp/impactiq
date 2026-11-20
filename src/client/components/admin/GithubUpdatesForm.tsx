import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Save as SaveIcon, Trash2, CheckCircle2, ArrowUpCircle, Eye, EyeOff, CalendarClock, X, Zap } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import type { ChangelogItem } from '../../../shared/changelogCategories.js'

interface UpdateConfigSummary {
  configured: boolean
  owner: string | null
  repo: string | null
  pinnedBranch: string
}

interface UpdateCheckStatus {
  checkedAt: string | null
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  newEntries: Array<{ version: string; date: string; highlights: ChangelogItem[] }>
  error: string | null
}

interface MaintenanceWindowData {
  scheduledAt: string
  message: string | null
  status: 'scheduled' | 'completed' | 'cancelled'
  createdByEmail: string | null
}

// Local datetime-local input format (YYYY-MM-DDTHH:mm, no timezone — the
// browser interprets it in the viewer's own local time, which is what an
// admin picking "tonight at 10pm" actually means).
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// v1.332.0: Admin → Integrations → App Updates card. Follows SlackForm's
// self-fetching pattern (its config shape — owner/repo/PAT/pinned branch —
// doesn't fit the shared IntegrationConfigSummary type any more than
// Slack's bot-token shape did). See CLAUDE.md and rbac.ts: any App Admin can
// view this card; only the designated default admin can save/clear the PAT
// or trigger a live "Check now".
export function GithubUpdatesForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const canAct = !!user?.isDefaultAdmin

  const [summary, setSummary] = useState<UpdateConfigSummary | null>(null)
  const [status, setStatus] = useState<UpdateCheckStatus | null>(null)
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [pat, setPat] = useState('')
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [win, setWin] = useState<MaintenanceWindowData | null>(null)
  const [scheduledAtInput, setScheduledAtInput] = useState('')
  const [maintMessage, setMaintMessage] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [maintErr, setMaintErr] = useState<string | null>(null)

  async function reload() {
    const [cfgRes, statusRes, winRes] = await Promise.all([
      api.get<UpdateConfigSummary>('/api/admin/updates/settings'),
      api.get<UpdateCheckStatus | null>('/api/admin/updates/status'),
      api.get<MaintenanceWindowData | null>('/api/admin/maintenance-window'),
    ])
    setSummary(cfgRes.data ?? { configured: false, owner: null, repo: null, pinnedBranch: 'main' })
    setOwner(cfgRes.data?.owner ?? '')
    setRepo(cfgRes.data?.repo ?? '')
    setStatus(statusRes.data ?? null)
    const w = winRes.data ?? null
    setWin(w)
    if (w?.status === 'scheduled') {
      setScheduledAtInput(toDatetimeLocalValue(new Date(w.scheduledAt)))
      setMaintMessage(w.message ?? '')
    }
  }
  useEffect(() => { void reload() }, [])

  async function scheduleMaintenance() {
    if (!scheduledAtInput) return
    const dt = new Date(scheduledAtInput)
    if (Number.isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
      setMaintErr(t('admin.integrations.github.maintenance.must_be_future'))
      return
    }
    if (!window.confirm(t('admin.integrations.github.maintenance.schedule_confirm', { when: dt.toLocaleString() }))) return
    setScheduling(true); setMaintErr(null)
    const res = await api.put<MaintenanceWindowData>('/api/admin/maintenance-window', { scheduledAt: dt.toISOString(), message: maintMessage.trim() || null })
    setScheduling(false)
    if (res.error) { setMaintErr(res.error); return }
    setWin(res.data ?? null)
  }

  // v1.336.0: "Restart Now" — the same PUT /maintenance-window route the
  // scheduler uses, just with scheduledAt a few seconds out instead of an
  // admin-picked future time, so restart_scheduler.ts's own 15s tick catches
  // it almost immediately with no new backend route needed. Deliberately
  // NOT instant (scheduledAt <= Date.now() is rejected server-side anyway) —
  // a small buffer means anyone mid-save still gets a moment, and the
  // MaintenanceBanner's own "final 30 minutes" countdown state (harmless at
  // any magnitude — Math.max(0, ...) clamped) has a beat to render before
  // the process actually exits. Still just a restart of what's already
  // running, same "not a deploy" caveat as the scheduled path above.
  async function restartNow() {
    if (!window.confirm(t('admin.integrations.github.maintenance.restart_now_confirm'))) return
    const when = new Date(Date.now() + 15_000)
    setScheduling(true); setMaintErr(null)
    const res = await api.put<MaintenanceWindowData>('/api/admin/maintenance-window', {
      scheduledAt: when.toISOString(),
      message: maintMessage.trim() || null,
    })
    setScheduling(false)
    if (res.error) { setMaintErr(res.error); return }
    setWin(res.data ?? null)
  }

  async function cancelMaintenance() {
    if (!window.confirm(t('admin.integrations.github.maintenance.cancel_confirm'))) return
    await api.delete('/api/admin/maintenance-window')
    setWin(null)
    setScheduledAtInput('')
    setMaintMessage('')
  }

  async function save() {
    if (!owner.trim() || !repo.trim() || !pat.trim()) return
    if (!window.confirm(t('admin.integrations.github.save_confirm'))) return
    setSaving(true); setErr(null)
    const res = await api.put('/api/admin/updates/settings', { owner: owner.trim(), repo: repo.trim(), pat: pat.trim() })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    setPat('')
    await reload()
    onSaved()
  }

  async function clear() {
    if (!window.confirm(t('admin.integrations.github.clear_confirm'))) return
    await api.delete('/api/admin/updates/settings')
    await reload()
    onSaved()
  }

  async function checkNow() {
    setChecking(true); setErr(null)
    const res = await api.post<UpdateCheckStatus>('/api/admin/updates/check-now', {})
    setChecking(false)
    if (res.error) { setErr(res.error); return }
    setStatus(res.data ?? null)
  }

  if (!summary) return <Spinner className="h-4 w-4" />

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="text-sm">
          <span className="text-gray-500 dark:text-gray-400">{t('admin.integrations.github.status')}: </span>
          <span className={summary.configured ? 'text-green-700 dark:text-green-400' : 'text-gray-500'}>
            {summary.configured ? t('admin.integrations.connected') : t('admin.integrations.not_connected')}
          </span>
          {summary.configured && summary.owner && summary.repo && (
            <span className="ml-2 text-gray-500 dark:text-gray-400">· {summary.owner}/{summary.repo}</span>
          )}
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.integrations.github.pinned_branch', { branch: summary.pinnedBranch })}
        </p>
      </div>

      {status && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800/50">
          {status.error ? (
            <p className="text-red-600 dark:text-red-400">{t('admin.integrations.github.check_error', { error: status.error })}</p>
          ) : status.updateAvailable ? (
            <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
              <ArrowUpCircle className="h-4 w-4" />
              {t('admin.integrations.github.update_available', { version: status.latestVersion })}
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              {t('admin.integrations.github.up_to_date', { version: status.currentVersion })}
            </p>
          )}
          {status.checkedAt && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('admin.integrations.github.last_checked', { when: new Date(status.checkedAt).toLocaleString() })}
            </p>
          )}
        </div>
      )}

      {!canAct && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.github.default_admin_only')}</p>
      )}

      {canAct && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('admin.integrations.github.owner_label')}>
              <TextInputLocal value={owner} onChange={setOwner} placeholder="egarlepp" />
            </Field>
            <Field label={t('admin.integrations.github.repo_label')}>
              <TextInputLocal value={repo} onChange={setRepo} placeholder="impactiq" />
            </Field>
          </div>
          <Field label={t('admin.integrations.github.pat_label')} hint={t('admin.integrations.github.pat_hint')}>
            <MaskedInputLocal value={pat} onChange={setPat} placeholder={summary.configured ? t('admin.integrations.secret_placeholder') : 'ghp_...'} />
          </Field>

          {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving || !owner.trim() || !repo.trim() || !pat.trim()}>
              {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
            {summary.configured && (
              <>
                <Button size="sm" variant="outline" onClick={checkNow} disabled={checking}>
                  {checking ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  {t('admin.integrations.github.check_now')}
                </Button>
                <Button size="sm" variant="outline" onClick={clear}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" />{t('admin.integrations.github.clear')}
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {/* v1.333.0: App Updates Phase 2 — schedule/cancel the maintenance
          window every signed-in user sees announced via MaintenanceBanner.tsx.
          Status is visible to any App Admin viewing this card; the form
          itself is default-admin-only, same split as the section above. */}
      <div className="mt-1 flex flex-col gap-3 border-t border-gray-200 pt-3 dark:border-gray-700">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
          <CalendarClock className="h-3.5 w-3.5" />
          {t('admin.integrations.github.maintenance.title')}
        </p>

        {win?.status === 'scheduled' ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <span>
              {t('admin.integrations.github.maintenance.currently_scheduled', { when: new Date(win.scheduledAt).toLocaleString() })}
              {win.message && <span className="block opacity-90">"{win.message}"</span>}
            </span>
            {canAct && (
              <button
                type="button"
                onClick={cancelMaintenance}
                className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
              >
                <X className="mr-1 inline h-3 w-3" />{t('admin.integrations.github.maintenance.cancel')}
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.github.maintenance.none_scheduled')}</p>
        )}

        {canAct && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('admin.integrations.github.maintenance.when_label')}>
                <input
                  type="datetime-local"
                  value={scheduledAtInput}
                  onChange={(e) => setScheduledAtInput(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                />
              </Field>
              <Field label={t('admin.integrations.github.maintenance.message_label')} hint={t('admin.integrations.github.maintenance.message_hint')}>
                <TextInputLocal value={maintMessage} onChange={setMaintMessage} placeholder={t('admin.integrations.github.maintenance.message_placeholder')} />
              </Field>
            </div>
            {maintErr && <p className="text-xs text-red-600 dark:text-red-400">{t(maintErr)}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={scheduleMaintenance} disabled={scheduling || !scheduledAtInput}>
                {scheduling ? <Spinner className="mr-1 h-3 w-3" /> : <CalendarClock className="mr-1 h-3.5 w-3.5" />}
                {win?.status === 'scheduled' ? t('admin.integrations.github.maintenance.reschedule') : t('admin.integrations.github.maintenance.schedule')}
              </Button>
              <Button size="sm" variant="outline" onClick={restartNow} disabled={scheduling} title={t('admin.integrations.github.maintenance.restart_now_hint')}>
                {scheduling ? <Spinner className="mr-1 h-3 w-3" /> : <Zap className="mr-1 h-3.5 w-3.5" />}
                {t('admin.integrations.github.maintenance.restart_now')}
              </Button>
            </div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {t('admin.integrations.github.maintenance.restart_now_hint')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

// Small local duplicates of IntegrationsStatus.tsx's presentational
// MaskedInput/TextInput/Field — those aren't exported, and this codebase's
// established convention is to duplicate small presentational helpers
// rather than export/import across sibling integration-card files.
function MaskedInputLocal({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative flex items-center">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 pr-9 font-mono text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
        autoComplete="off"
      />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" tabIndex={-1}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

function TextInputLocal({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 font-mono text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
      autoComplete="off"
    />
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 dark:text-gray-500">{hint}</p>}
    </div>
  )
}
