import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CalendarSearch, Check, Copy, Eye, KeyRound, Link2, RefreshCw, Save, Trash2, Unlink, UserCog, Webhook } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Select } from '../ui/select.js'
import { Textarea } from '../ui/textarea.js'
import { Spinner } from '../ui/spinner.js'
import type { GongConnectionSummary, GongTeamTranscriptAccess, GongUserOption } from '../../../shared/gong.js'

// Transcript settings on the Gong card (Gong plan, phase 2): run the call
// index by hand, the per-team "Leaders can read transcripts" switch, and
// manual links between an ImpactIQ user and a Gong user for people whose
// emails differ. App Admin only, like the rest of the card.

interface IndexResult { calls: number; backfillDone: boolean; removed: number }

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

export function GongTranscriptSettings({ summary, onSummary }: {
  summary: GongConnectionSummary
  onSummary: (s: GongConnectionSummary) => void
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [indexResult, setIndexResult] = useState<IndexResult | null>(null)
  const [teams, setTeams] = useState<GongTeamTranscriptAccess[] | null>(null)
  const [savingTeam, setSavingTeam] = useState<string | null>(null)
  const [gongUsers, setGongUsers] = useState<GongUserOption[] | null>(null)
  const [linkUser, setLinkUser] = useState('')
  const [linkGongUser, setLinkGongUser] = useState('')
  const [linking, setLinking] = useState<string | null>(null)
  const [savingLinking, setSavingLinking] = useState(false)
  const [webhookKey, setWebhookKey] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.get<GongTeamTranscriptAccess[]>('/api/admin/integrations/gong/transcript-access').then((res) => {
      if (cancelled) return
      if (res.error) setError(t(res.error))
      else setTeams(res.data ?? [])
    })
    void api.get<GongUserOption[]>('/api/admin/integrations/gong/users').then((res) => {
      if (cancelled) return
      if (res.error) setError(t(res.error))
      else setGongUsers(res.data ?? [])
    })
    return () => { cancelled = true }
  }, [t, summary.users.lastSyncedAt])

  async function runIndex() {
    setIndexing(true)
    setError(null)
    const res = await api.post<IndexResult>('/api/admin/integrations/gong/index-calls', {})
    setIndexing(false)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    setIndexResult(res.data)
  }

  async function setLeaderAccess(teamId: string, leadersCanRead: boolean) {
    setSavingTeam(teamId)
    setError(null)
    const res = await api.put<GongTeamTranscriptAccess>(`/api/admin/integrations/gong/transcript-access/${teamId}`, { leadersCanRead })
    setSavingTeam(null)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    const updated = res.data
    setTeams((rows) => (rows ? rows.map((r) => (r.teamId === updated.teamId ? updated : r)) : rows))
  }

  async function saveLink(userId: string, gongUserId: string | null) {
    setLinking(userId)
    setError(null)
    const res = await api.put<GongConnectionSummary>(`/api/admin/integrations/gong/user-links/${userId}`, { gongUserId })
    setLinking(null)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    onSummary(res.data)
    setLinkUser('')
    setLinkGongUser('')
  }

  async function saveLinking(patch: { autoLink?: boolean; webhookPublicKey?: string | null }) {
    setSavingLinking(true)
    setError(null)
    const res = await api.put<GongConnectionSummary>('/api/admin/integrations/gong/linking', patch)
    setSavingLinking(false)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    onSummary(res.data)
    if (patch.webhookPublicKey !== undefined) setWebhookKey('')
  }

  async function copyWebhookUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const unmatched = summary.users.unmatchedUsers
  const manual = summary.users.manualLinks

  return (
    <div className="flex flex-col gap-3 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
      {error && <ErrorBox message={error} />}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
            <CalendarSearch className="h-4 w-4 text-gray-500 dark:text-gray-400" />
            {t('admin.integrations.gong.index_title')}
          </p>
          <Button size="sm" variant="outline" onClick={() => { void runIndex() }} disabled={indexing}>
            {indexing ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            {t('admin.integrations.gong.index_now')}
          </Button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.index_hint')}</p>
        {indexResult && (
          <p className="text-xs text-gray-600 dark:text-gray-300">
            {t('admin.integrations.gong.index_result', { count: indexResult.calls })}
            {' '}
            {indexResult.backfillDone ? t('admin.integrations.gong.index_backfill_done') : t('admin.integrations.gong.index_backfill_running')}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2.5 dark:border-gray-800">
        <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
          <Link2 className="h-4 w-4 text-gray-500 dark:text-gray-400" />
          {t('admin.integrations.gong.auto_link_title')}
        </p>
        <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={summary.autoLink}
            disabled={savingLinking || !summary.configured}
            onChange={(e) => { void saveLinking({ autoLink: e.target.checked }) }}
          />
          {t('admin.integrations.gong.auto_link_label')}
          {savingLinking && <Spinner className="h-3 w-3" />}
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.auto_link_hint')}</p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2.5 dark:border-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
            <Webhook className="h-4 w-4 text-gray-500 dark:text-gray-400" />
            {t('admin.integrations.gong.webhook_title')}
          </p>
          <span className={summary.webhook.publicKeyOnFile
            ? 'flex items-center gap-1 text-xs text-green-700 dark:text-green-400'
            : 'flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400'}
          >
            <KeyRound className="h-3.5 w-3.5" />
            {summary.webhook.publicKeyOnFile ? t('admin.integrations.gong.webhook_on') : t('admin.integrations.gong.webhook_off')}
          </span>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.webhook_hint')}</p>
        {summary.webhook.url ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">{summary.webhook.url}</code>
            <Button size="sm" variant="ghost" onClick={() => { void copyWebhookUrl(summary.webhook.url ?? '') }}>
              {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
              {copied ? t('admin.integrations.gong.webhook_copied') : t('admin.integrations.gong.webhook_copy')}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-amber-700 dark:text-amber-400">{t('admin.integrations.gong.webhook_no_url')}</p>
        )}
        <Textarea
          value={webhookKey}
          onChange={(e) => setWebhookKey(e.target.value)}
          rows={3}
          placeholder={t('admin.integrations.gong.webhook_key_placeholder')}
          aria-label={t('admin.integrations.gong.webhook_key_label')}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => { void saveLinking({ webhookPublicKey: webhookKey }) }} disabled={savingLinking || webhookKey.trim() === ''}>
            {savingLinking ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            {t('admin.integrations.gong.webhook_save')}
          </Button>
          {summary.webhook.publicKeyOnFile && (
            <Button size="sm" variant="ghost" onClick={() => { void saveLinking({ webhookPublicKey: null }) }} disabled={savingLinking}>
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              {t('admin.integrations.gong.webhook_remove')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2.5 dark:border-gray-800">
        <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
          <Eye className="h-4 w-4 text-gray-500 dark:text-gray-400" />
          {t('admin.integrations.gong.access_title')}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.access_hint')}</p>
        {teams === null ? (
          <Spinner className="h-4 w-4" />
        ) : teams.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.access_no_teams')}</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {teams.map((team) => (
              <li key={team.teamId}>
                <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={team.leadersCanRead}
                    disabled={savingTeam !== null}
                    onChange={(e) => { void setLeaderAccess(team.teamId, e.target.checked) }}
                  />
                  {team.name}
                  {savingTeam === team.teamId && <Spinner className="h-3 w-3" />}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2.5 dark:border-gray-800">
        <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
          <UserCog className="h-4 w-4 text-gray-500 dark:text-gray-400" />
          {t('admin.integrations.gong.links_title')}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.links_hint')}</p>
        {manual.length > 0 && (
          <ul className="flex flex-col gap-1">
            {manual.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-700 dark:text-gray-300">
                <span>
                  {m.displayName} <span className="text-gray-400 dark:text-gray-500">{m.email}</span>
                  {' → '}
                  {m.gongUserName ?? m.gongUserId}
                </span>
                <Button size="sm" variant="ghost" onClick={() => { void saveLink(m.id, null) }} disabled={linking !== null}>
                  {linking === m.id ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Unlink className="mr-1 h-3.5 w-3.5" />}
                  {t('admin.integrations.gong.links_clear')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {unmatched.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.links_none_unmatched')}</p>
        ) : !gongUsers || gongUsers.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.links_sync_first')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={linkUser}
              onChange={(e) => setLinkUser(e.target.value)}
              aria-label={t('admin.integrations.gong.links_user')}
              className="w-56"
            >
              <option value="">{t('admin.integrations.gong.links_user')}</option>
              {unmatched.map((u) => <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>)}
            </Select>
            <Select
              value={linkGongUser}
              onChange={(e) => setLinkGongUser(e.target.value)}
              aria-label={t('admin.integrations.gong.links_gong_user')}
              className="w-56"
            >
              <option value="">{t('admin.integrations.gong.links_gong_user')}</option>
              {gongUsers.map((g) => <option key={g.id} value={g.id}>{g.email ? `${g.name} (${g.email})` : g.name}</option>)}
            </Select>
            <Button size="sm" onClick={() => { void saveLink(linkUser, linkGongUser) }} disabled={!linkUser || !linkGongUser || linking !== null}>
              {linking === linkUser && linkUser ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Link2 className="mr-1 h-3.5 w-3.5" />}
              {t('admin.integrations.gong.links_save')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
