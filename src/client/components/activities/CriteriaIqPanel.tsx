import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, ListChecks, Unlink } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { findCriteriaIqMismatches, type ProjectComparable } from '../../../shared/criteriaiqMismatch.js'

// v1.386.0: CriteriaIQ as the secondary Project source (CLAUDE.md §9). Sits
// under the CRM Evaluation's own fields in EvalFieldsPanel and adds what the
// CRM object doesn't carry: criteria progress, the CriteriaIQ status (where
// TCC shows up), and a link out to the CriteriaIQ project. The CRM's values
// stay the ones ImpactIQ shows and stores; where CriteriaIQ disagrees, this
// panel only flags it.
//
// Renders nothing while an App Admin hasn't turned the secondary on, so it
// can be mounted unconditionally. A CriteriaIQ outage shows a one-line
// notice and never affects the CRM fields above it.

interface ProjectSummary {
  id: number
  name: string
  status: string | null
  type: string | null
  startDate: string | null
  endDate: string | null
  primaryEngineerName: string | null
  criteriaTotal: number | null
  criteriaMet: number | null
  mapTasksTotal: number | null
  mapTasksCompleted: number | null
  url: string
}

type LinkState =
  | { state: 'off' }
  | { state: 'linked'; how: 'auto' | 'picked'; project: ProjectSummary; candidates: ProjectSummary[] }
  | { state: 'choose'; matchedBy: 'evaluation' | 'opportunity'; candidates: ProjectSummary[] }
  | { state: 'none' }
  | { state: 'unavailable'; error: string }

interface Props {
  recordId: string
  oppId?: string | null
  oppName?: string | null
  primary: ProjectComparable
  disabled?: boolean
}

const MISMATCH_LABEL: Record<string, string> = {
  status: 'activity.form.eval_status_label',
  startDate: 'activity.form.eval_start_date_label',
  endDate: 'activity.form.eval_end_date_label',
  primaryEngineer: 'activity.criteriaiq.primary_engineer',
}

export function CriteriaIqPanel({ recordId, oppId, oppName, primary, disabled }: Props) {
  const { t } = useTranslation()
  const [link, setLink] = useState<LinkState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  const oppQuery = `${oppId ? `&oppId=${encodeURIComponent(oppId)}` : ''}${oppName ? `&oppName=${encodeURIComponent(oppName)}` : ''}`

  useEffect(() => {
    let cancelled = false
    setLink(null)
    setPicking(false)
    void (async () => {
      const res = await api.get<LinkState>(`/api/criteriaiq/evaluation-link?recordId=${encodeURIComponent(recordId)}${oppQuery}`)
      if (cancelled) return
      // A failed call is treated like an outage: the CRM fields keep working.
      setLink(res.data ?? { state: 'unavailable', error: res.error ?? 'errors.criteriaiq.unreachable' })
    })()
    return () => { cancelled = true }
  }, [recordId, oppQuery])

  async function choose(projectId: number) {
    setSaving(true)
    setError(null)
    const res = await api.put<LinkState>('/api/criteriaiq/evaluation-link', { recordId, projectId, ...(oppId ? { oppId } : {}), ...(oppName ? { oppName } : {}) })
    setSaving(false)
    if (res.error || !res.data) { setError(res.error ?? 'errors.criteriaiq.unreachable'); return }
    setLink(res.data)
    setPicking(false)
  }

  async function unlink() {
    setSaving(true)
    setError(null)
    const res = await api.delete<LinkState>(`/api/criteriaiq/evaluation-link?recordId=${encodeURIComponent(recordId)}${oppQuery}`)
    setSaving(false)
    if (res.error || !res.data) { setError(res.error ?? 'errors.criteriaiq.unreachable'); return }
    setLink(res.data)
  }

  if (link === null) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500">
        <Spinner className="h-3 w-3" /> {t('activity.criteriaiq.checking')}
      </div>
    )
  }
  if (link.state === 'off') return null

  const header = (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      <ListChecks className="h-3 w-3" /> {t('activity.criteriaiq.title')}
    </span>
  )
  const shell = 'flex flex-col gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900'

  if (link.state === 'unavailable') {
    return (
      <div className={shell}>
        {header}
        <p className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {t('activity.criteriaiq.unavailable')}
        </p>
      </div>
    )
  }
  if (link.state === 'none') {
    return (
      <div className={shell}>
        {header}
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('activity.criteriaiq.none')}</p>
      </div>
    )
  }

  const chooser = (candidates: ProjectSummary[], hint: string) => (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] text-gray-600 dark:text-gray-300">{hint}</p>
      <select
        defaultValue=""
        disabled={disabled || saving}
        onChange={(e) => { const id = Number(e.target.value); if (id) void choose(id) }}
        aria-label={t('activity.criteriaiq.choose_label')}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      >
        <option value="">{t('activity.criteriaiq.choose_placeholder')}</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.name}{c.status ? ` (${c.status})` : ''}</option>
        ))}
      </select>
    </div>
  )

  if (link.state === 'choose') {
    return (
      <div className={shell}>
        {header}
        {chooser(link.candidates, t(link.matchedBy === 'evaluation' ? 'activity.criteriaiq.choose_evaluation' : 'activity.criteriaiq.choose_opportunity', { count: link.candidates.length }))}
        {saving && <Spinner className="h-3 w-3" />}
        {error && <p className="text-[10px] text-red-600 dark:text-red-400">{t(error)}</p>}
      </div>
    )
  }

  const p = link.project
  const mismatches = findCriteriaIqMismatches(primary, {
    status: p.status, startDate: p.startDate, endDate: p.endDate, primaryEngineer: p.primaryEngineerName,
  })
  const pct = p.criteriaTotal ? Math.round(((p.criteriaMet ?? 0) / p.criteriaTotal) * 100) : null

  return (
    <div className={shell}>
      <div className="flex items-center gap-2">
        {header}
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex min-w-0 items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
          title={t('activity.criteriaiq.open')}
        >
          <span className="truncate">{p.name}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600 dark:text-gray-300">
        {p.status && (
          <span><span className="text-gray-400">{t('activity.form.eval_status_label')}:</span> <span className="font-medium">{p.status}</span></span>
        )}
        {p.criteriaTotal !== null && (
          p.criteriaTotal === 0 ? (
            <span className="text-gray-500 dark:text-gray-400">{t('activity.criteriaiq.no_criteria')}</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              {t('activity.criteriaiq.criteria_progress', { met: p.criteriaMet ?? 0, total: p.criteriaTotal })}
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700" aria-hidden="true">
                <span className="block h-full rounded-full bg-emerald-500 dark:bg-emerald-400" style={{ width: `${pct ?? 0}%` }} />
              </span>
            </span>
          )
        )}
        {!!p.mapTasksTotal && (
          <span className="inline-flex items-center gap-1.5">
            <ListChecks className="h-3 w-3 text-blue-600 dark:text-blue-400" />
            {t('activity.criteriaiq.map_progress', { done: p.mapTasksCompleted ?? 0, total: p.mapTasksTotal })}
          </span>
        )}
      </div>
      {mismatches.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="inline-flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3 shrink-0" /> {t('activity.criteriaiq.mismatch_title')}
          </p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {mismatches.map((m) => (
              <li key={m.field}>
                {t(MISMATCH_LABEL[m.field] ?? m.field)}: {t('activity.criteriaiq.mismatch_values', { crm: m.primary, criteriaiq: m.criteriaiq })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {link.how === 'picked' && !picking && (
        <div className="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
          {link.candidates.length > 1 && (
            <button type="button" disabled={disabled || saving} onClick={() => setPicking(true)} className="inline-flex items-center gap-1 hover:text-blue-600 disabled:opacity-50 dark:hover:text-blue-400">
              <Link2 className="h-3 w-3" /> {t('activity.criteriaiq.change')}
            </button>
          )}
          <button type="button" disabled={disabled || saving} onClick={() => void unlink()} className="inline-flex items-center gap-1 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400">
            <Unlink className="h-3 w-3" /> {t('activity.criteriaiq.unlink')}
          </button>
          {saving && <Spinner className="h-3 w-3" />}
        </div>
      )}
      {picking && chooser(link.candidates, t('activity.criteriaiq.change_hint'))}
      {error && <p className="text-[10px] text-red-600 dark:text-red-400">{t(error)}</p>}
    </div>
  )
}
