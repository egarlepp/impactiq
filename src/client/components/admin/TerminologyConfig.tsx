import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Info, Save, SpellCheck, X } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Spinner } from '../ui/spinner.js'
import { setTerminologyState } from '../../store/terminology.js'
import {
  CUSTOM_EVAL_TERM_MAX, EVAL_TERM_LABELS, EVAL_TERM_OPTIONS, cleanCustomEvalTerm, evalWorkTypeName,
  type EvalTermOption, type Terminology,
} from '../../../shared/terminology.js'

interface RenamePlan {
  from: string
  to: string
  types: Array<{ id: string; teamNames: string[] }>
  conflicts: Array<{ id: string; teamNames: string[] }>
}

interface SaveResult {
  typesRenamed: number
  typesSkipped: number
}

// Admin → Workplace → Terminology (src/shared/terminology.ts). One app-wide
// choice of what the org calls an evaluation; it names the "{term} Work"
// Activity Type and the {{evalTerm}} / {{evalWork}} wording everywhere. A
// change that would rename existing Activity Types asks first.
export function TerminologyConfig() {
  const { t } = useTranslation()
  const [saved, setSaved] = useState<Terminology | null>(null)
  const [evalTerm, setEvalTerm] = useState<EvalTermOption>('pox')
  const [custom, setCustom] = useState('')
  const [plan, setPlan] = useState<RenamePlan | null>(null)
  const [renameTypes, setRenameTypes] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<Terminology>('/api/admin/terminology').then((res) => {
      if (cancelled) return
      if (res.data) {
        setSaved(res.data)
        setEvalTerm(res.data.evalTerm)
        setCustom(res.data.customEvalTerm ?? '')
      } else setError(res.error)
    })
    return () => { cancelled = true }
  }, [])

  const cleanCustom = evalTerm === 'custom' ? cleanCustomEvalTerm(custom) : null
  const draft: Terminology = { evalTerm, customEvalTerm: cleanCustom }
  const customInvalid = evalTerm === 'custom' && !cleanCustom
  const dirty = !!saved && (saved.evalTerm !== evalTerm || (evalTerm === 'custom' && (saved.customEvalTerm ?? '') !== (cleanCustom ?? '')))
  const previewName = customInvalid ? '—' : evalWorkTypeName(draft)

  async function commit(rename: boolean) {
    setBusy(true)
    setError(null)
    const res = await api.put<Terminology>('/api/admin/terminology', { ...draft, renameTypes: rename })
    setBusy(false)
    if (!res.data) { setError(res.error); return }
    const result = (res.meta as { result?: SaveResult } | undefined)?.result
    setSaved(res.data)
    setPlan(null)
    setTerminologyState(res.data)
    setNotice(result && result.typesRenamed > 0
      ? t('admin.terminology.saved_renamed', { count: result.typesRenamed, name: evalWorkTypeName(res.data) })
      : t('admin.terminology.saved'))
  }

  async function save() {
    if (customInvalid) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const res = await api.post<RenamePlan>('/api/admin/terminology/preview', draft)
    setBusy(false)
    if (!res.data) { setError(res.error); return }
    if (res.data.types.length === 0 && res.data.conflicts.length === 0) { await commit(false); return }
    setRenameTypes(true)
    setPlan(res.data)
  }

  if (!saved && !error) return <div className="flex justify-center p-6"><Spinner /></div>

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <SpellCheck className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.terminology.title')}</h2>
      </div>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t('admin.terminology.description')}</p>
      <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <Label htmlFor="eval-term" className="mb-1 block">{t('admin.terminology.eval_term_label')}</Label>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.terminology.eval_term_hint')}</p>
            <Select
              id="eval-term"
              value={evalTerm}
              onChange={(e) => { setEvalTerm(e.target.value as EvalTermOption); setPlan(null); setNotice(null) }}
              className="w-full"
            >
              {EVAL_TERM_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o === 'custom' ? t('admin.terminology.option_custom') : t(`admin.terminology.option_${o}`, { term: EVAL_TERM_LABELS[o] })}
                </option>
              ))}
            </Select>
            {evalTerm === 'custom' && (
              <div className="mt-3">
                <Label htmlFor="eval-term-custom" className="mb-1 block">{t('admin.terminology.custom_label')}</Label>
                <Input
                  id="eval-term-custom"
                  value={custom}
                  maxLength={CUSTOM_EVAL_TERM_MAX}
                  placeholder={t('admin.terminology.custom_placeholder')}
                  onChange={(e) => { setCustom(e.target.value); setPlan(null); setNotice(null) }}
                />
                {custom.trim() !== '' && customInvalid && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('errors.terminology.custom_invalid', { max: CUSTOM_EVAL_TERM_MAX })}</p>
                )}
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-200">
              <Info className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              {t('admin.terminology.preview_title')}
            </div>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.terminology.preview_hint')}</p>
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800/40">
              <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.terminology.preview_type')}</div>
              <div className="mt-0.5 font-semibold text-gray-900 dark:text-gray-100">{previewName}</div>
              <div className="mt-2 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.terminology.preview_distinction')}</div>
              <div className="mt-0.5 text-gray-800 dark:text-gray-100">{t('admin.terminology.preview_distinction_text', { evalWork: previewName })}</div>
            </div>
          </div>
        </div>

        {plan && (
          <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" />
              {t('admin.terminology.confirm_title')}
            </div>
            {plan.types.length > 0 && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={renameTypes} onChange={(e) => setRenameTypes(e.target.checked)} />
                <span>
                  {t('admin.terminology.confirm_rename', { count: plan.types.length, from: plan.from, to: plan.to })}
                  <span className="mt-0.5 block text-xs opacity-80">
                    {[...new Set(plan.types.flatMap((x) => x.teamNames))].join(', ')}
                  </span>
                </span>
              </label>
            )}
            <p className="mt-2 text-xs">{t('admin.terminology.confirm_rename_keeps')}</p>
            {plan.conflicts.length > 0 && (
              <p className="mt-2 text-xs">
                {t('admin.terminology.confirm_conflicts', { count: plan.conflicts.length, from: plan.from, to: plan.to, teams: [...new Set(plan.conflicts.flatMap((x) => x.teamNames))].join(', ') })}
              </p>
            )}
            {!renameTypes && <p className="mt-2 text-xs">{t('admin.terminology.confirm_keep', { from: plan.from })}</p>}
            <div className="mt-3 flex items-center gap-2">
              <Button onClick={() => { void commit(renameTypes && plan.types.length > 0) }} disabled={busy}>
                {busy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                {t('admin.terminology.confirm_save')}
              </Button>
              <Button variant="outline" onClick={() => setPlan(null)} disabled={busy}>
                <X className="mr-1 h-3.5 w-3.5" />
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {!plan && (
          <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-700">
            <Button onClick={() => { void save() }} disabled={busy || !dirty || customInvalid}>
              {busy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('admin.terminology.save')}
            </Button>
            {notice && <span className="text-xs text-green-600 dark:text-green-400">{notice}</span>}
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-6 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-semibold">{t('admin.terminology.affects_title')}</div>
            <div>{t('admin.terminology.affects_desc')}</div>
          </div>
        </div>
      </div>
    </section>
  )
}
