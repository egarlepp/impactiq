import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Pencil, Target } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { evalTypeIcon } from '../../lib/sf-icons.js'
import { SfFieldPrependPanel } from '../salesforce/SfFieldPrependPanel.js'
import { CriteriaIqPanel } from './CriteriaIqPanel.js'
import { useCrmApiBase, useCrmLabelContext } from '../../store/crmProvider.js'

// v1.148.0 / v1.149.0: Evaluation ("Project") field panel. Shared between
// ActivityForm's Project box and the SfActivitiesModal drill-in.
//
// Data: paints instantly from the local snapshot (/api/activities/
// eval-fields, no SF call) then overlays authoritative live SF values
// (/api/salesforce/evaluations/:id). This means a just-linked Project
// shows real values even before the nightly refresh has stamped the
// snapshot. Object-agnostic — the caller passes the real SF object API
// name (cfg.sobject / crmRelatedType), so any tenant's Evaluation object
// name works.
//
// Layout: compact Status / Stage / Type box (always shown when data is
// present — "SHOW BELOW") + an expand toggle revealing all 5 fields as
// editable dropdowns/dates ("SHOW WHEN EXPANDED" adds Start/End dates).
// Edits write live to Salesforce.

interface EvalData {
  status: string | null
  stage: string | null
  type: string | null
  startDate: string | null
  endDate: string | null
}

interface PicklistOption { value: string; label: string }

const EDITABLE_FIELDS: Array<{ key: 'eval_status' | 'eval_stage' | 'eval_type' | 'eval_start_date' | 'eval_end_date'; dataKey: keyof EvalData; labelKey: string; fallback: string; kind: 'dropdown' | 'date' }> = [
  { key: 'eval_status', dataKey: 'status', labelKey: 'activity.form.eval_status_label', fallback: 'Status', kind: 'dropdown' },
  { key: 'eval_stage', dataKey: 'stage', labelKey: 'activity.form.eval_stage_label', fallback: 'Stage', kind: 'dropdown' },
  { key: 'eval_type', dataKey: 'type', labelKey: 'activity.form.eval_type_label', fallback: 'Type', kind: 'dropdown' },
  { key: 'eval_start_date', dataKey: 'startDate', labelKey: 'activity.form.eval_start_date_label', fallback: 'Start Date', kind: 'date' },
  { key: 'eval_end_date', dataKey: 'endDate', labelKey: 'activity.form.eval_end_date_label', fallback: 'End Date', kind: 'date' },
]

interface Props {
  teamId: string
  // SF object API name (e.g. "Evaluations__c") — cfg.sobject in the form,
  // crmRelatedType in the drill-in modal. Everything is looked up by this.
  sobject: string
  relatedId: string
  relatedName: string
  // The linked Opportunity's id and name, when known. Lets the CriteriaIQ
  // panel suggest CriteriaIQ projects on the same Opportunity when none points
  // at this Evaluation directly.
  oppId?: string | null
  oppName?: string | null
  disabled?: boolean
}

export function EvalFieldsPanel({ teamId, sobject, relatedId, relatedName, oppId, oppName, disabled }: Props) {
  const { t } = useTranslation()
  const crmBase = useCrmApiBase()
  const crmCtx = useCrmLabelContext()
  const [data, setData] = useState<EvalData | null>(null)
  // What a person reads, when it differs from the value the editor sends
  // (HubSpot option labels for raw option values). Null on Salesforce, whose
  // picklist values are the labels.
  const [labels, setLabels] = useState<Partial<EvalData> | null>(null)
  const [loading, setLoading] = useState(true)
  // Whether this SF object actually has eval field mappings. When false
  // (e.g. a non-Evaluation related picker), we render just a plain
  // "Linked: <name>" line — no compact box, no editor.
  const [mapped, setMapped] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [picklists, setPicklists] = useState<Record<string, PicklistOption[]>>({})
  const [picklistsLoaded, setPicklistsLoaded] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Primary Engineer comes only from the local snapshot; the CriteriaIQ
  // panel compares it with CriteriaIQ's.
  const [primaryEngineer, setPrimaryEngineer] = useState<string | null>(null)

  async function loadData() {
    setLoading(true)
    // 1. Instant paint from the local snapshot.
    const local = await api.get<{ crmEvalStatus: string | null; crmEvalStage: string | null; crmEvalType: string | null; crmEvalStartDate: string | null; crmEvalEndDate: string | null; crmEvalPrimaryEngineer: string | null }>(`/api/activities/eval-fields?teamId=${teamId}&relatedId=${encodeURIComponent(relatedId)}`)
    setPrimaryEngineer(local.data?.crmEvalPrimaryEngineer ?? null)
    setLabels(null)
    if (local.data) {
      setData({
        status: local.data.crmEvalStatus, stage: local.data.crmEvalStage, type: local.data.crmEvalType,
        startDate: local.data.crmEvalStartDate, endDate: local.data.crmEvalEndDate,
      })
    }
    // 2. Authoritative live SF read (overwrites when it lands).
    const live = await api.get<{ eval_status: string | null; eval_stage: string | null; eval_type: string | null; eval_start_date: string | null; eval_end_date: string | null } | null>(`${crmBase}/evaluations/${encodeURIComponent(relatedId)}?teamId=${teamId}&sobject=${encodeURIComponent(sobject)}`)
    if (live.meta?.['unmapped'] === true && !local.data) setMapped(false)
    if (live.data) {
      setMapped(true)
      setData({
        status: live.data.eval_status, stage: live.data.eval_stage, type: live.data.eval_type,
        startDate: live.data.eval_start_date, endDate: live.data.eval_end_date,
      })
      const l = live.meta?.['labels'] as Record<string, string | null> | undefined
      if (l) setLabels({ status: l['eval_status'] ?? null, stage: l['eval_stage'] ?? null, type: l['eval_type'] ?? null })
    }
    setLoading(false)
  }
  useEffect(() => { void loadData() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamId, sobject, relatedId, crmBase])

  // Lazy-load picklist options the first time the edit section opens.
  useEffect(() => {
    if (!expanded || picklistsLoaded) return
    let cancelled = false
    void (async () => {
      const fields = ['eval_status', 'eval_stage', 'eval_type']
      const results = await Promise.all(fields.map((f) => api.get<PicklistOption[]>(`${crmBase}/evaluations/picklist-values?teamId=${teamId}&sobject=${encodeURIComponent(sobject)}&field=${f}`)))
      if (cancelled) return
      const next: Record<string, PicklistOption[]> = {}
      fields.forEach((f, i) => { next[f] = results[i]?.data ?? [] })
      setPicklists(next)
      setPicklistsLoaded(true)
    })()
    return () => { cancelled = true }
  }, [expanded, picklistsLoaded, teamId, sobject, crmBase])

  async function saveField(key: string, value: string) {
    setSaving(key)
    setSaveError(null)
    const res = await api.patch<{ ok: boolean }>(`${crmBase}/evaluations/${encodeURIComponent(relatedId)}`, { teamId, sobject, fields: { [key]: value || null } })
    setSaving(null)
    if (res.error) { setSaveError(res.error); return }
    void loadData()
  }

  const shown = {
    status: labels?.status ?? data?.status ?? null,
    stage: labels?.stage ?? data?.stage ?? null,
    type: labels?.type ?? data?.type ?? null,
  }
  const Icon = evalTypeIcon(shown.type) ?? Target
  const hasCompactInfo = !!(shown.status || shown.stage || shown.type)

  // Not an eval object (no mappings) → plain linked line, matching the
  // pre-v1.148 RelatedObjectPicker behavior for non-Evaluation pickers.
  if (!mapped) {
    return (
      <p className="text-[10px] text-gray-500 dark:text-gray-400">
        {t('activity.form.linked_label', 'Linked:')} <span className="font-medium text-gray-700 dark:text-gray-200">{relatedName}</span>
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {loading && !data ? (
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400"><Spinner className="h-3 w-3" /> {t('common.loading', 'Loading…')}</div>
      ) : (
        <>
          {hasCompactInfo && (
            <div className="flex flex-wrap gap-2 rounded-md border border-dashed border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
              {shown.status && (
                <span><span className="text-gray-400">{t('activity.form.eval_status_label', 'Status')}:</span> <span className="font-medium">{shown.status}</span></span>
              )}
              {shown.stage && (
                <span><span className="text-gray-400">{t('activity.form.eval_stage_label', 'Stage')}:</span> <span className="font-medium">{shown.stage}</span></span>
              )}
              {shown.type && (
                <span><span className="text-gray-400">{t('activity.form.eval_type_label', 'Type')}:</span> <span className="font-medium">{shown.type}</span></span>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            disabled={disabled}
            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Icon className="h-3 w-3" />
            {t('activity.form.linked_label', 'Linked:')} <span className="font-medium text-gray-700 dark:text-gray-200">{relatedName}</span>
            <Pencil className="ml-1 h-2.5 w-2.5 opacity-60" />
          </button>
          {expanded && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-[10px] italic text-gray-400 dark:text-gray-500">
                {t('activity.form.eval_fields_live_note', { context: crmCtx })}
              </p>
              {EDITABLE_FIELDS.map((f) => {
                const currentValue = data?.[f.dataKey] ?? ''
                return (
                  <div key={f.key} className="flex items-center gap-2">
                    <label className="w-24 shrink-0 text-[11px] text-gray-500 dark:text-gray-400">{t(f.labelKey, f.fallback)}</label>
                    {f.kind === 'dropdown' ? (
                      <select
                        value={currentValue}
                        onChange={(e) => void saveField(f.key, e.target.value)}
                        disabled={disabled || saving === f.key}
                        className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      >
                        <option value="">—</option>
                        {(picklists[f.key] ?? []).map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                        {/* Keep the current value selectable even if it's not in the live picklist (e.g. inactive value). */}
                        {currentValue && !(picklists[f.key] ?? []).some((o) => o.value === currentValue) && (
                          <option value={currentValue}>{currentValue}</option>
                        )}
                      </select>
                    ) : (
                      <input
                        type="date"
                        value={currentValue}
                        onChange={(e) => void saveField(f.key, e.target.value)}
                        disabled={disabled || saving === f.key}
                        className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      />
                    )}
                    {saving === f.key && <Spinner className="h-3 w-3" />}
                  </div>
                )
              })}
              {saveError && <p className="text-[10px] text-red-600 dark:text-red-400">{saveError.startsWith('errors.') ? t(saveError) : saveError}</p>}

              {/* Prepend-update fields (v1.254.0) — a dated note posted
                  ABOVE existing content, history preserved, unlike the
                  overwrite-on-change fields above. Renders nothing if the
                  team has no eval_next_steps mapping configured. */}
              <SfFieldPrependPanel
                teamId={teamId}
                sobject={sobject}
                recordId={relatedId}
                appField="eval_next_steps"
                labelFallback={t('activity.form.eval_next_steps_label', 'Situation / Next Steps')}
                disabled={disabled}
              />
            </div>
          )}
          <CriteriaIqPanel
            recordId={relatedId}
            oppId={oppId}
            oppName={oppName}
            primary={{ status: shown.status, startDate: data?.startDate ?? null, endDate: data?.endDate ?? null, primaryEngineer }}
            disabled={disabled}
          />
        </>
      )}
    </div>
  )
}
