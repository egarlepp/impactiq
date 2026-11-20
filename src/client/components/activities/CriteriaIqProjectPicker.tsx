import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Building2, CheckCircle2, ExternalLink, Info, ListChecks, Pencil, Search, Sparkles, X } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { CRITERIAIQ_RELATED_TYPE } from '../../../shared/evaluationSource.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.388.0: the activity form's Project picker when CriteriaIQ is the
// primary Project source (CLAUDE.md §9). Takes the place of the Salesforce
// related-object picker for an activity type with a Project picker
// configured. Suggests the CriteriaIQ projects named for the linked
// Opportunity (CriteriaIQ stores the Opportunity by name only), and a search
// box finds any other project by name, customer or Opportunity. The pick is
// stored as crm_related_type 'CriteriaIQ' + the CriteriaIQ project id; the
// server reads the project itself on save for the snapshot.

export interface CriteriaIqProjectSummary {
  id: number
  name: string
  status: string | null
  type: string | null
  startDate: string | null
  endDate: string | null
  primaryEngineerName: string | null
  criteriaTotal: number | null
  criteriaMet: number | null
  url: string
}

const shell = 'flex flex-col gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900'

function day(v: string | null): string | null {
  return v ? v.slice(0, 10) : null
}

// One CriteriaIQ project's details: name (links out), status, type, dates,
// Primary Engineer and criteria progress. Used under the picker and in the
// Project drill-in.
export function CriteriaIqProjectBox({ projectId, fallbackName }: { projectId: string; fallbackName?: string | null }) {
  const { t } = useTranslation()
  const [project, setProject] = useState<CriteriaIqProjectSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void api.get<CriteriaIqProjectSummary>(`/api/criteriaiq/projects/${encodeURIComponent(projectId)}`).then((res) => {
      if (cancelled) return
      setProject(res.data ?? null)
      setError(res.data ? null : (res.error ?? 'errors.criteriaiq.unreachable'))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [projectId])

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500">
        <Spinner className="h-3 w-3" /> {t('activity.criteriaiq.checking')}
      </div>
    )
  }
  if (!project) {
    return (
      <div className="flex flex-col gap-0.5 text-[11px]">
        {fallbackName && <span className="font-medium text-gray-800 dark:text-gray-200">{fallbackName}</span>}
        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {t(error ?? 'errors.criteriaiq.unreachable')}
        </span>
      </div>
    )
  }

  const pct = project.criteriaTotal ? Math.round(((project.criteriaMet ?? 0) / project.criteriaTotal) * 100) : null
  const fields: Array<[string, string | null]> = [
    [t('activity.form.eval_status_label'), project.status],
    [t('activity.form.eval_type_label'), project.type],
    [t('activity.form.eval_start_date_label'), day(project.startDate)],
    [t('activity.form.eval_end_date_label'), day(project.endDate)],
    [t('activity.criteriaiq.primary_engineer'), project.primaryEngineerName],
  ]
  return (
    <div className="flex flex-col gap-1">
      <a
        href={project.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        title={t('activity.criteriaiq.open')}
      >
        <span className="truncate">{project.name}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600 dark:text-gray-300">
        {fields.filter(([, v]) => !!v).map(([label, v]) => (
          <span key={label}><span className="text-gray-400 dark:text-gray-500">{label}:</span> <span className="font-medium">{v}</span></span>
        ))}
        {project.criteriaTotal !== null && (
          project.criteriaTotal === 0 ? (
            <span className="text-gray-500 dark:text-gray-400">{t('activity.criteriaiq.no_criteria')}</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              {t('activity.criteriaiq.criteria_progress', { met: project.criteriaMet ?? 0, total: project.criteriaTotal })}
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700" aria-hidden="true">
                <span className="block h-full rounded-full bg-emerald-500 dark:bg-emerald-400" style={{ width: `${pct ?? 0}%` }} />
              </span>
            </span>
          )
        )}
      </div>
    </div>
  )
}

interface PickerProps {
  label?: string
  oppId: string | null
  oppName: string | null
  accountId: string | null
  selectedId: string | null
  selectedName: string | null
  onPick: (sobject: string, id: string, name: string) => void
  disabled?: boolean
}

export function CriteriaIqProjectPicker({ label, oppId, oppName, accountId, selectedId, selectedName, onPick, disabled }: PickerProps) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [changing, setChanging] = useState(false)
  const [suggested, setSuggested] = useState<CriteriaIqProjectSummary[]>([])
  const [matchedBy, setMatchedBy] = useState<'id' | 'name' | null>(null)
  const [accountSuggested, setAccountSuggested] = useState<CriteriaIqProjectSummary[]>([])
  const [results, setResults] = useState<CriteriaIqProjectSummary[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choosing = !selectedId || changing

  // Suggestions for the linked Opportunity (by the CRM id CriteriaIQ stores,
  // else by name) and other projects on its Account, loaded whenever the
  // picker is in choosing mode.
  useEffect(() => {
    if (!choosing || (!oppId && !oppName && !accountId)) { setSuggested([]); setAccountSuggested([]); setMatchedBy(null); return }
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (oppId) params.set('oppId', oppId)
    if (oppName) params.set('oppName', oppName)
    if (accountId) params.set('accountId', accountId)
    void api.get<{ suggested: CriteriaIqProjectSummary[]; matchedBy: 'id' | 'name' | null; accountSuggested: CriteriaIqProjectSummary[] }>(`/api/criteriaiq/projects?${params.toString()}`).then((res) => {
      if (cancelled) return
      setSuggested(res.data?.suggested ?? [])
      setMatchedBy(res.data?.matchedBy ?? null)
      setAccountSuggested(res.data?.accountSuggested ?? [])
      setError(res.data ? null : (res.error ?? null))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [choosing, oppId, oppName, accountId])

  // Search, debounced so typing doesn't send a request per key.
  useEffect(() => {
    const text = query.trim()
    if (!choosing || text.length < 2) { setResults([]); return }
    let cancelled = false
    const timer = setTimeout(() => {
      setLoading(true)
      void api.get<{ results: CriteriaIqProjectSummary[] }>(`/api/criteriaiq/projects?q=${encodeURIComponent(text)}`).then((res) => {
        if (cancelled) return
        setResults(res.data?.results ?? [])
        setError(res.data ? null : (res.error ?? null))
        setLoading(false)
      })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [choosing, query])

  function pick(p: CriteriaIqProjectSummary) {
    onPick(CRITERIAIQ_RELATED_TYPE, String(p.id), p.name)
    setChanging(false)
    setQuery('')
  }

  const option = (p: CriteriaIqProjectSummary) => (
    <li key={p.id}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => pick(p)}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <span className="truncate text-gray-900 dark:text-gray-100">{p.name}</span>
        {p.status && <span className="ml-auto shrink-0 text-[10px] text-gray-500 dark:text-gray-400">{p.status}</span>}
      </button>
    </li>
  )

  return (
    <div className={shell}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{label || t('activity.criteriaiq_picker.title')}</span>
        <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          <ListChecks className="h-3 w-3" /> {t('activity.criteriaiq.title')}
        </span>
        {loading && <Spinner className="ml-1 h-3 w-3" />}
        {selectedId && !disabled && (
          <span className="ml-auto flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
            <button type="button" onClick={() => setChanging((c) => !c)} className="inline-flex items-center gap-1 hover:text-blue-600 dark:hover:text-blue-400">
              {changing ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
              {changing ? t('common.cancel') : t('activity.criteriaiq.change')}
            </button>
            <button type="button" onClick={() => { onPick(CRITERIAIQ_RELATED_TYPE, '', ''); setChanging(false) }} className="inline-flex items-center gap-1 hover:text-red-600 dark:hover:text-red-400">
              <X className="h-3 w-3" /> {t('activity.criteriaiq_picker.remove')}
            </button>
          </span>
        )}
      </div>

      {selectedId && !changing && <CriteriaIqProjectBox projectId={selectedId} fallbackName={selectedName} />}

      {choosing && !disabled && (
        <div className="flex flex-col gap-1.5">
          {(oppId || oppName) && (
            <div className="flex flex-col gap-0.5">
              <p className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <Sparkles className="h-3 w-3" /> {t('activity.criteriaiq_picker.suggested', { context: crmCtx })}
              </p>
              {suggested.length === 0 && !loading
                ? <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('activity.criteriaiq_picker.no_suggestions', { context: crmCtx })}</p>
                : <ul className="flex flex-col">{suggested.map(option)}</ul>}
              {matchedBy === 'name' && suggested.length > 0 && (
                <p className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
                  <Info className="h-3 w-3 shrink-0" /> {t('activity.criteriaiq_picker.matched_by_name', { context: crmCtx })}
                </p>
              )}
            </div>
          )}
          {accountSuggested.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <p className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <Building2 className="h-3 w-3" /> {t('activity.criteriaiq_picker.account_suggested', { context: crmCtx })}
              </p>
              <ul className="flex flex-col">{accountSuggested.map(option)}</ul>
            </div>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('activity.criteriaiq_picker.search_placeholder')}
              aria-label={t('activity.criteriaiq_picker.search_placeholder')}
              className="w-full rounded-md border border-gray-300 bg-white py-1 pl-7 pr-2 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
          {query.trim().length >= 2 && (
            results.length === 0 && !loading
              ? <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('activity.criteriaiq_picker.no_results')}</p>
              : <ul className="flex max-h-48 flex-col overflow-y-auto">{results.map(option)}</ul>
          )}
          {error && (
            <p className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3 shrink-0" /> {t(error)}
            </p>
          )}
        </div>
      )}
      {!selectedId && disabled && <p className="text-[11px] text-gray-500 dark:text-gray-400">—</p>}
    </div>
  )
}
