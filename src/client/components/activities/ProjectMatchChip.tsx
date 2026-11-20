import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Target, ChevronDown, Search } from 'lucide-react'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { useEvaluationSource } from '../../store/evaluationSource.js'
import { useCrmApiBase, useCrmLabelContext } from '../../store/crmProvider.js'
import { CRITERIAIQ_RELATED_TYPE } from '../../../shared/evaluationSource.js'

// v1.100.0: Project / related-SObject chip on suggested-activity cards.
// Driven by the activity type's Salesforce Extras config
// (team_activity_type_crm_extras.kind = 'related_object_picker'). Loads
// candidates from /api/salesforce/opportunities/:oppId/related for each
// configured related object. Selection lives in the parent as
// { id, name, sobject } and is written into crmRelatedType/Id/Name on
// Approve — the same shape the ActivityForm already produces for Eval
// Work today. v1.388.0: with CriteriaIQ as the primary Project source, the
// candidates are the CriteriaIQ projects named for the same Opportunity.

interface SfExtraRow {
  id: string
  kind: 'opp_field_display' | 'related_object_picker'
  config: {
    label?: string
    sobject?: string
    parentField?: string
    labelField?: string
  }
}

interface Props {
  activityTypeId: string
  oppId: string
  // The Opportunity's name: the fallback match for a CriteriaIQ project that
  // doesn't hold the Opportunity's id.
  oppName?: string | null
  current: { id: string; name: string; sobject: string } | null
  onPick: (pick: { id: string; name: string; sobject: string }) => void
  onClear: () => void
  // v1.180.0: lets the parent (SuggestedActivityCard) know whether this
  // activity type has a related-object (e.g. Evaluation) picker configured, so
  // the Approve pre-check can require a selection without hardcoding "Eval Work".
  onApplicableChange?: (applicable: boolean) => void
}

export function ProjectMatchChip({ activityTypeId, oppId, oppName, current, onPick, onClear, onApplicableChange }: Props) {
  const { t } = useTranslation()
  const criteriaIqPrimary = useEvaluationSource().primary === 'criteriaiq'
  const crmBase = useCrmApiBase()
  const crmCtx = useCrmLabelContext()
  const [open, setOpen] = useState(false)
  const [extras, setExtras] = useState<SfExtraRow[]>([])
  const [rows, setRows] = useState<Array<{ id: string; name: string; sobject: string }>>([])
  const [loading, setLoading] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.get<SfExtraRow[]>(`/api/activities/sf-extras/${activityTypeId}`).then((res) => {
      if (cancelled) return
      const pickers = (res.data ?? []).filter((r) => r.kind === 'related_object_picker' && (criteriaIqPrimary || r.config.sobject))
      setExtras(pickers)
      onApplicableChange?.(pickers.length > 0)
    })
    return () => { cancelled = true }
  }, [activityTypeId, onApplicableChange, criteriaIqPrimary])

  useEffect(() => {
    if (!open || extras.length === 0 || !oppId) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      const all: Array<{ id: string; name: string; sobject: string }> = []
      if (criteriaIqPrimary) {
        const params = new URLSearchParams({ oppId })
        if (oppName) params.set('oppName', oppName)
        const res = await api.get<{ suggested: Array<{ id: number; name: string }> }>(`/api/criteriaiq/projects?${params.toString()}`)
        for (const p of res?.data?.suggested ?? []) all.push({ id: String(p.id), name: p.name, sobject: CRITERIAIQ_RELATED_TYPE })
        if (!cancelled) { setRows(all); setLoading(false) }
        return
      }
      for (const x of extras) {
        const params = new URLSearchParams({
          sobject: x.config.sobject!,
          parentField: x.config.parentField ?? 'Opportunity__c',
          labelField: x.config.labelField ?? 'Name',
        })
        const res = await api.get<Array<{ id: string; name: string }>>(`${crmBase}/opportunities/${encodeURIComponent(oppId)}/related?${params.toString()}`)
        for (const r of res.data ?? []) all.push({ ...r, sobject: x.config.sobject! })
      }
      if (!cancelled) { setRows(all); setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [open, extras, oppId, oppName, criteriaIqPrimary, crmBase])

  // Rendered into document.body via a portal with position:fixed so it
  // escapes the card's own overflow/stacking context — otherwise a chip on
  // a card near the bottom of the scrollable activity list gets its
  // popover clipped by the card below it (same fix as SingleSelect/
  // MultiSelect/SubteamFilter/SubtypeFilter/PossibleMatchChip).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const b = btnRef.current.getBoundingClientRect()
    setRect({ top: b.bottom + 4, left: b.left })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    function onScroll(e: Event) {
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onResize() { setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  // No project pickers configured for this activity type → render nothing.
  // The Suggested card only mounts us when the activity type is likely to
  // have projects (e.g. Eval Work), so this is a safety net.
  if (extras.length === 0) return null

  const projectLabel = extras[0]?.config.label ?? t('activity.match.project_label')
  const buttonLabel = current
    ? `${projectLabel}: ${current.name}`
    : t('activity.match.pick_kind', { kind: projectLabel })

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
          current
            ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-dashed border-gray-300 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400',
        )}
        title={buttonLabel}
      >
        <Target className="h-3 w-3 shrink-0" />
        <span className="max-w-[180px] truncate">{buttonLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </button>
      {open && rect && createPortal(
        <div
          ref={popRef}
          className="fixed z-[100] min-w-[240px] rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ top: rect.top, left: rect.left }}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
            {t('activity.match.possible_kind', { kind: projectLabel })}
          </div>
          <ul className="max-h-56 overflow-y-auto py-1 text-sm">
            {loading && <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('common.loading', 'Loading…')}</li>}
            {!loading && rows.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{criteriaIqPrimary ? t('activity.criteriaiq_picker.no_suggestions') : t('activity.match.none_project', { context: crmCtx })}</li>
            )}
            {rows.map((c) => (
              <li key={`${c.sobject}-${c.id}`}>
                <button
                  type="button"
                  onClick={() => { setOpen(false); onPick(c) }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800',
                    current?.id === c.id && 'bg-blue-50 dark:bg-blue-950/40',
                  )}
                >
                  <Target className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{c.name}</span>
                </button>
              </li>
            ))}
            {current && (
              <li>
                <button
                  type="button"
                  onClick={() => { setOpen(false); onClear() }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  {t('activity.match.clear')}
                </button>
              </li>
            )}
            <li className="border-t border-gray-100 dark:border-gray-800">
              <span className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-500 dark:text-gray-400">
                <Search className="h-3.5 w-3.5" />
                {t('activity.match.search_more_hint')}
              </span>
            </li>
          </ul>
        </div>,
        document.body,
      )}
    </div>
  )
}
