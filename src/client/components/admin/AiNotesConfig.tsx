import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DollarSign, Info, Power, PowerOff, Save, Sparkles } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import type { AiNotesTeamSettings } from '../../../shared/aiNotes.js'

// Admin → Workplace → AI Notes (v1.457.0, Gong plan phase 4). The team's AI
// Notes switch (Team Admins) and its monthly spend limit (App Admins), inside
// the app-wide budget on Admin → AI Assistant. Default sections are the
// team's Default Settings Profile (v1.471.0), in AiNoteProfilesConfig.
export function AiNotesConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState<AiNotesTeamSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [limit, setLimit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function take(s: AiNotesTeamSettings) {
    setSaved(s)
    setEnabled(s.enabled)
    setLimit(s.monthlyLimitUsd === null ? '' : String(s.monthlyLimitUsd))
  }

  useEffect(() => {
    setSaved(null)
    setError(null)
    setNotice(null)
    let cancelled = false
    api.get<AiNotesTeamSettings>(`/api/admin/teams/${teamId}/ai-notes`).then((res) => {
      if (cancelled) return
      if (res.data) take(res.data)
      else setError(res.error)
    })
    return () => { cancelled = true }
  }, [teamId])

  if (!saved) {
    return error
      ? <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{t(error)}</p>
      : <div className="flex justify-center py-8"><Spinner /></div>
  }

  const limitTrim = limit.trim()
  const limitValue = limitTrim === '' ? null : Number(limitTrim)
  const limitInvalid = limitValue !== null && (!Number.isFinite(limitValue) || limitValue < 0)
  const limitDirty = saved.canEditLimit && !limitInvalid && limitValue !== saved.monthlyLimitUsd
  const dirty = enabled !== saved.enabled || limitDirty

  async function save() {
    setBusy(true)
    setError(null)
    setNotice(null)
    const body: Record<string, unknown> = { enabled }
    if (limitDirty) body['monthlyLimitUsd'] = limitValue
    const res = await api.put<AiNotesTeamSettings>(`/api/admin/teams/${teamId}/ai-notes`, body)
    setBusy(false)
    if (res.error || !res.data) { setError(res.error ?? 'errors.server'); return }
    take(res.data)
    setNotice(t('admin.ai_notes.saved'))
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div className="flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('admin.ai_notes.intro')}</span>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              {t('admin.ai_notes.enabled_label')}
            </h3>
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{t('admin.ai_notes.enabled_hint')}</p>
          </div>
          <Button type="button" size="sm" variant={enabled ? 'default' : 'outline'} onClick={() => setEnabled(!enabled)} disabled={busy}>
            {enabled ? <Power className="mr-1 h-3.5 w-3.5" /> : <PowerOff className="mr-1 h-3.5 w-3.5" />}
            {enabled ? t('admin.ai_notes.on') : t('admin.ai_notes.off')}
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <Label htmlFor="ai-notes-limit" className="flex items-center gap-1.5 text-sm font-semibold">
          <DollarSign className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          {t('admin.ai_notes.limit_label')}
        </Label>
        <p className="mb-2 mt-0.5 text-xs text-gray-600 dark:text-gray-400">
          {saved.canEditLimit ? t('admin.ai_notes.limit_hint') : t('admin.ai_notes.limit_hint_readonly')}
        </p>
        <div className="flex items-center gap-2">
          <Input
            id="ai-notes-limit"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className="w-40"
            value={limit}
            placeholder={t('admin.ai_notes.limit_placeholder')}
            onChange={(e) => setLimit(e.target.value)}
            disabled={!saved.canEditLimit || busy}
          />
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {t('admin.ai_notes.spent', { spent: `$${saved.spentThisMonthUsd.toFixed(2)}` })}
          </span>
        </div>
        {limitInvalid ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('admin.ai_notes.limit_invalid')}</p> : null}
      </section>

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{t(error)}</p> : null}
      {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
      <div>
        <Button type="button" onClick={() => void save()} disabled={!dirty || busy || limitInvalid}>
          {busy ? <Spinner className="mr-1 h-4 w-4" /> : <Save className="mr-1 h-4 w-4" />}
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}
