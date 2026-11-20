import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mail, CheckCircle2, CircleSlash, Power, PowerOff, RefreshCcw, Pencil, Send, X, Save, Eye, MessageSquare, ShieldCheck } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { emailRuleSupportsSlackDm, ADMIN_ONLY_EMAIL_RULES } from '../../../shared/emailRuleSlack.js'

// v1.230.0: shape of GET /api/admin/integrations/config's `smtp` field —
// reused here (not a separate endpoint) purely to surface the current
// send-from address; the field is still called "smtp" for backward
// compatibility even though it also covers Graph App-Only.
interface EmailIntegrationSummary {
  authMethod: 'smtp' | 'graph_app'
  fromAddress: string | null
}

// v1.113.0: Admin registry for every outbound email code path.
// v1.114.0: added per-rule template editor (subject + body) + Send Test.

interface EmailRuleRow {
  key: string
  name: string
  description: string | null
  isActive: boolean
  subjectTemplate: string | null
  bodyTemplate: string | null
  sendSlack?: boolean
  createdAt: string
  updatedAt: string
}

// Token hints shown in the editor so admins know what {{tokens}} they can
// use in each template. Keep in sync with server-side sendByRule().
const TOKEN_HINTS: Record<string, string[]> = {
  login_new_location: ['{{name}}', '{{ip}}', '{{userAgent}}', '{{signInTime}}'],
  weekly_recap: ['{{name}}', '{{weekLabel}}', '{{totalHours}}', '{{capacityHours}}'],
  daily_digest: ['{{name}}', '{{count}}', '{{itemsList}}'],
  nudge_email: ['{{name}}', '{{message}}'],
  admin_test_email: ['{{name}}', '{{triggeredBy}}'],
  smtp_test: ['{{name}}', '{{triggeredBy}}'],
  welcome: ['{{name}}', '{{teamName}}', '{{loginUrl}}'],
  invitation: ['{{name}}', '{{teamName}}', '{{tempPassword}}', '{{loginUrl}}'],
  job_failure_alert: ['{{jobKey}}', '{{when}}', '{{message}}'],
  ai_budget_reached: ['{{budget}}', '{{spent}}', '{{month}}'],
}

export function EmailCommunicationsConfig() {
  const { t } = useTranslation()
  const [rules, setRules] = useState<EmailRuleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<EmailRuleRow | null>(null)
  const [fSubject, setFSubject] = useState('')
  const [fBody, setFBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ key: string; ok: boolean; message: string } | null>(null)
  // v1.115.0: live-rendered preview HTML for the editor iframe.
  const [previewHtml, setPreviewHtml] = useState<string>('')
  const [previewSubject, setPreviewSubject] = useState<string>('')
  // v1.230.0: "From" isn't per-rule — it's the one email integration
  // configured under Admin → Integrations. Surfaced here read-only so an
  // admin looking at rule templates can see where the send actually comes
  // from without hopping pages.
  const [fromInfo, setFromInfo] = useState<EmailIntegrationSummary | null>(null)
  // v1.436.0: whether the Slack bot is connected (Admin → Integrations → Slack).
  const [slackConfigured, setSlackConfigured] = useState(false)

  async function reload() {
    setLoading(true)
    const res = await api.get<EmailRuleRow[]>('/api/admin/email-rules')
    setRules(res.data ?? [])
    setSlackConfigured(!!(res.meta as { slackConfigured?: boolean } | undefined)?.slackConfigured)
    setLoading(false)
  }
  useEffect(() => {
    void reload()
    void api.get<{ smtp: EmailIntegrationSummary | null }>('/api/admin/integrations/config')
      .then((res) => setFromInfo(res.data?.smtp ?? null))
  }, [])

  async function toggle(rule: EmailRuleRow) {
    setBusy(rule.key)
    await api.patch(`/api/admin/email-rules/${encodeURIComponent(rule.key)}`, { isActive: !rule.isActive })
    setRules((prev) => prev.map((r) => (r.key === rule.key ? { ...r, isActive: !r.isActive } : r)))
    setBusy(null)
  }

  async function toggleSlack(rule: EmailRuleRow) {
    setBusy(`slack:${rule.key}`)
    const next = !rule.sendSlack
    const res = await api.patch<EmailRuleRow>(`/api/admin/email-rules/${encodeURIComponent(rule.key)}`, { sendSlack: next })
    if (res.data) setRules((prev) => prev.map((r) => (r.key === rule.key ? { ...r, sendSlack: next } : r)))
    setBusy(null)
  }

  function openEdit(r: EmailRuleRow) {
    setEditing(r)
    setFSubject(r.subjectTemplate ?? '')
    setFBody(r.bodyTemplate ?? '')
    setPreviewHtml('')
    setPreviewSubject('')
  }

  // v1.115.0: live-render the current subject/body via /preview so the
  // editor iframe reflects tokens filled with sample values. Debounced
  // 400ms so keystrokes don't storm the server.
  useEffect(() => {
    if (!editing) return
    const t = window.setTimeout(async () => {
      const res = await api.post<{ html: string; subject: string }>(`/api/admin/email-rules/${encodeURIComponent(editing.key)}/preview`, {
        subjectTemplate: fSubject.trim() || null,
        bodyTemplate: fBody.trim() || null,
      })
      if (res.data) {
        setPreviewHtml(res.data.html)
        setPreviewSubject(res.data.subject)
      }
    }, 400)
    return () => window.clearTimeout(t)
  }, [editing, fSubject, fBody])

  async function saveEdit() {
    if (!editing) return
    setSaving(true)
    const res = await api.patch<EmailRuleRow>(`/api/admin/email-rules/${encodeURIComponent(editing.key)}`, {
      subjectTemplate: fSubject.trim() || null,
      bodyTemplate: fBody.trim() || null,
    })
    setSaving(false)
    if (res.data) setRules((prev) => prev.map((r) => (r.key === editing.key ? { ...r, ...res.data! } : r)))
    setEditing(null)
  }

  async function sendTest(rule: EmailRuleRow) {
    setBusy(`test:${rule.key}`)
    setTestResult(null)
    const res = await api.post<{ ok: boolean; message: string }>(`/api/admin/email-rules/${encodeURIComponent(rule.key)}/send-test`, {})
    setBusy(null)
    setTestResult({ key: rule.key, ok: !!res.data?.ok, message: res.error ?? res.data?.message ?? 'sent' })
    window.setTimeout(() => setTestResult(null), 6000)
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-3">
      {/* v1.115.0: dropped the in-page "Email Communications" title
          since the page header already shows it. Refresh moves to the
          right of the description. */}
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-4xl text-xs text-gray-500 dark:text-gray-400">
          {t('admin.email_comm.subtitle', 'Every outbound email the app can send is listed here. Toggle a rule off to stop that specific email from being dispatched — the underlying triggers (login, digest tick, nudge sync, etc.) keep running, they just skip the email leg. Click Edit to override the subject + body template, and Send test to preview it in your inbox.')}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void reload()}>
          <RefreshCcw className="mr-1 h-3.5 w-3.5" />
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>

      {/* v1.230.0: read-only — "from" is one app-wide setting (Admin →
          Integrations → Email), not per-rule. Shown here so an admin
          reviewing/editing templates can see where the send actually
          comes from without leaving this page. */}
      {fromInfo?.fromAddress ? (
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Mail className="h-3.5 w-3.5" />
          {t('admin.email_comm.sending_from', 'Sending from: {{address}}', { address: fromInfo.fromAddress })}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <Mail className="h-3.5 w-3.5" />
          {t('admin.email_comm.not_configured', 'Email isn’t configured yet — set it up in Admin → Integrations before any of these rules can send.')}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800/50 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2">{t('admin.email_comm.name', 'Rule')}</th>
              <th className="px-3 py-2">{t('admin.email_comm.description', 'Trigger / description')}</th>
              <th className="px-3 py-2">{t('admin.email_comm.status', 'Status')}</th>
              <th className="px-3 py-2 text-right">{t('common.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.key} className="border-t border-gray-100 dark:border-gray-800">
                <td className="px-3 py-2 align-top">
                  <p className="font-medium text-gray-900 dark:text-gray-100">{r.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-gray-400 dark:text-gray-500">{r.key}</p>
                  {(r.subjectTemplate || r.bodyTemplate) && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                      <Pencil className="h-2.5 w-2.5" />
                      {t('admin.email_comm.custom_template', 'Custom template')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs text-gray-600 dark:text-gray-300">
                  {r.description ?? '—'}
                  {testResult?.key === r.key && (
                    <p className={testResult.ok ? 'mt-1 text-[11px] text-green-600 dark:text-green-400' : 'mt-1 text-[11px] text-red-600 dark:text-red-400'}>
                      {testResult.ok ? '✓' : '✗'} {testResult.message}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  <Badge variant={r.isActive ? 'success' : 'outline'} className="inline-flex items-center gap-1">
                    {r.isActive
                      ? <CheckCircle2 className="h-3 w-3" />
                      : <CircleSlash className="h-3 w-3" />}
                    {r.isActive ? t('admin.email_comm.active', 'Active') : t('admin.email_comm.inactive', 'Inactive')}
                  </Badge>
                  {emailRuleSupportsSlackDm(r.key) && (
                    <div className="mt-2 space-y-0.5">
                      <label
                        className={`flex items-center gap-1.5 text-[11px] ${slackConfigured ? 'cursor-pointer text-gray-700 dark:text-gray-300' : 'cursor-not-allowed text-gray-400 dark:text-gray-500'}`}
                        title={slackConfigured ? t('admin.email_comm.slack_dm_hint') : t('admin.email_comm.slack_not_connected')}
                      >
                        {busy === `slack:${r.key}`
                          ? <Spinner className="h-3 w-3" />
                          : (
                            <input
                              type="checkbox"
                              checked={!!r.sendSlack}
                              disabled={!slackConfigured}
                              onChange={() => void toggleSlack(r)}
                              className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 disabled:cursor-not-allowed dark:border-gray-600"
                            />
                          )}
                        <MessageSquare className="h-3 w-3 text-purple-600 dark:text-purple-400" />
                        {t('admin.email_comm.slack_dm_label')}
                      </label>
                      {ADMIN_ONLY_EMAIL_RULES.includes(r.key) && (
                        <p className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
                          <ShieldCheck className="h-3 w-3" />
                          {t('admin.email_comm.slack_admins_only')}
                        </p>
                      )}
                      {!slackConfigured && (
                        <p className="text-[10px] text-gray-400 dark:text-gray-500">{t('admin.email_comm.slack_not_connected')}</p>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(r)} title={t('admin.email_comm.edit', 'Edit template')}>
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      {t('common.edit', 'Edit')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void sendTest(r)} disabled={busy === `test:${r.key}`} title={t('admin.email_comm.send_test', 'Send a test to your own email')}>
                      {busy === `test:${r.key}` ? <Spinner className="mr-1 h-3 w-3" /> : <Send className="mr-1 h-3.5 w-3.5" />}
                      {t('admin.email_comm.test', 'Test')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggle(r)} disabled={busy === r.key}>
                      {busy === r.key
                        ? <Spinner className="mr-1 h-3 w-3" />
                        : r.isActive
                          ? <PowerOff className="mr-1 h-3.5 w-3.5" />
                          : <Power className="mr-1 h-3.5 w-3.5" />}
                      {r.isActive ? t('admin.email_comm.disable', 'Disable') : t('admin.email_comm.enable', 'Enable')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-xs text-gray-400 dark:text-gray-500">
                  {t('admin.email_comm.empty', 'No email rules registered. Run migration 0079.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => setEditing(null)}>
          <div className="w-full max-w-5xl rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
                <Pencil className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                {editing.name}
              </h3>
              <button onClick={() => setEditing(null)} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X className="h-4 w-4" /></button>
            </div>
            <p className="mb-3 font-mono text-[10px] text-gray-400 dark:text-gray-500">{editing.key}</p>

            <label className="mb-3 block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('admin.email_comm.subject', 'Subject')}
              <input
                type="text"
                value={fSubject}
                onChange={(e) => setFSubject(e.target.value)}
                placeholder={t('admin.email_comm.subject_placeholder', 'Leave blank to use the built-in default')}
                className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              />
            </label>

            <label className="mb-2 block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('admin.email_comm.body_html', 'Body (HTML)')}
              <textarea
                value={fBody}
                onChange={(e) => setFBody(e.target.value)}
                rows={12}
                placeholder={t('admin.email_comm.body_placeholder', 'Leave blank to use the built-in default. Supports basic HTML — <p>, <a>, <b>, <ul>/<li>, etc. Wrapped by the ImpactIQ template (top bar / footer) at send time.')}
                className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              />
            </label>
            <p className="mb-2 text-[10px] text-gray-500 dark:text-gray-400">
              {t('admin.email_comm.tokens', 'Tokens')}: {(TOKEN_HINTS[editing.key] ?? []).map((tok) => <code key={tok} className="mr-1 rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{tok}</code>)}
            </p>

            {/* v1.115.0: live preview iframe. Renders the same HTML
                recipients receive (theme wrap, top bar, tenant logo,
                interpolated sample tokens). */}
            <div className="mb-4">
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <span>{t('admin.email_comm.preview', 'Rendered preview (with sample tokens)')}</span>
                {previewSubject && <span className="font-mono normal-case text-[11px] text-gray-700 dark:text-gray-300">{t('admin.email_comm.subject_prefix', 'Subject:')} {previewSubject}</span>}
              </div>
              <iframe
                title={t('admin.email_comm.preview_title', 'Email preview')}
                srcDoc={previewHtml || '<p style="font-family:sans-serif;color:#6b7280;padding:1rem;">Loading preview…</p>'}
                sandbox=""
                className="h-96 w-full rounded border border-gray-200 bg-white dark:border-gray-700"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" onClick={() => void sendTest(editing)} disabled={busy === `test:${editing.key}`}>
                {busy === `test:${editing.key}` ? <Spinner className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
                {t('admin.email_comm.send_test_to_me', 'Send test to my email')}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={saving}>
                  <X className="h-4 w-4" />
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button size="sm" onClick={() => void saveEdit()} disabled={saving}>
                  {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                  {t('common.save', 'Save')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
