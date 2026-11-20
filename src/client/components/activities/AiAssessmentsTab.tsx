import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, ClipboardCheck, Clock, EyeOff, ExternalLink, Gauge, History, Play, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { scoreTone } from '../../lib/assessmentTone.js'
import { formatTranscriptOffset, gongCallUrlAt } from '../../../shared/gong.js'
import type { AiNoteCitation } from '../../../shared/aiNotes.js'
import type { AiAssessmentScore, AiAssessmentsActivityView } from '../../../shared/aiAssessments.js'

// The Assessments tab on the activity drawer (v1.462.0). Leaders only, never
// the activity's owner: the scores for each AI Assessment assigned to the
// activity's Type / Subtype, written when the owner's AI Notes Generate read
// a Gong transcript or when a Leader clicked Run assessment here. Two scores
// per rubric: not-observed criteria counted as zero, and observed criteria
// only, with the not-observed count beside it.

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

export function AiAssessmentsTab({ activityId, onCountChange }: { activityId: string; onCountChange?: (count: number) => void }) {
  const { t, i18n } = useTranslation()
  const [view, setView] = useState<AiAssessmentsActivityView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())

  function apply(next: AiAssessmentsActivityView) {
    setView(next)
    onCountChange?.(next.scores.length)
  }

  useEffect(() => {
    setView(null)
    setError(null)
    setOpen(new Set())
    let cancelled = false
    void api.get<AiAssessmentsActivityView>(`/api/ai-assessments/activities/${activityId}`).then((res) => {
      if (cancelled) return
      if (res.error) { setError(t(res.error)); return }
      if (res.data) apply(res.data)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId])

  async function run() {
    setRunning(true)
    setError(null)
    const res = await api.post<AiAssessmentsActivityView>(`/api/ai-assessments/activities/${activityId}/run`, {})
    setRunning(false)
    if (res.error) { setError(t(res.error)); return }
    if (res.data) apply(res.data)
  }

  function toggle(id: string) {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
  }

  if (!view && !error) return <div className="flex justify-center py-8"><Spinner /></div>
  if (!view) return <ErrorBox message={error ?? ''} />

  const callUrl = new Map(view.calls.map((c) => [c.id, c.url]))
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
  const blockedText = view.blockedReason ? t(`activity.ai_assessments.blocked.${view.blockedReason}`) : null

  const citation = (c: AiNoteCitation, i: number) => {
    if (c.kind !== 'transcript') return null
    const href = gongCallUrlAt(callUrl.get(c.callId) ?? null, c.startMs)
    const cls = 'inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 dark:border-gray-700 dark:text-gray-300'
    return href ? (
      <a key={i} href={href} target="_blank" rel="noopener noreferrer" className={`${cls} hover:border-indigo-300 hover:text-indigo-700 dark:hover:border-indigo-700 dark:hover:text-indigo-300`} title={t('activity.ai_notes.cite_call_hint')}>
        <Clock className="h-3 w-3" />
        {formatTranscriptOffset(c.startMs)}
        <ExternalLink className="h-3 w-3" />
      </a>
    ) : (
      <span key={i} className={cls}><Clock className="h-3 w-3" />{formatTranscriptOffset(c.startMs)}</span>
    )
  }

  const scoreCard = (s: AiAssessmentScore) => {
    const expanded = open.has(s.id)
    const panelId = `ai-assessment-${s.id}`
    const changed = s.currentVersion !== null && s.currentVersion !== s.assessmentVersion
    return (
      <section key={s.id} className="overflow-hidden rounded-md border border-l-4 border-gray-200 border-l-indigo-500 dark:border-gray-700 dark:border-l-indigo-400">
        <h3>
          <button
            type="button"
            onClick={() => toggle(s.id)}
            aria-expanded={expanded}
            aria-controls={panelId}
            className="flex w-full flex-wrap items-center gap-2 bg-indigo-50/60 px-3 py-2 text-left text-sm font-semibold text-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-100"
          >
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0 opacity-70" /> : <ChevronRight className="h-4 w-4 shrink-0 opacity-70" />}
            <ClipboardCheck className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-300" />
            <span className="min-w-0 flex-1 truncate">{s.assessmentName}</span>
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${scoreTone(s.zeroed)}`} title={t('activity.ai_assessments.score_zeroed_hint')}>
              <Gauge className="h-3 w-3" />
              {t('activity.ai_assessments.score_zeroed', { score: s.zeroed })}
            </span>
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${scoreTone(s.observed)}`} title={t('activity.ai_assessments.score_observed_hint')}>
              <Gauge className="h-3 w-3" />
              {s.observed === null ? t('activity.ai_assessments.score_observed_none') : t('activity.ai_assessments.score_observed', { score: s.observed })}
              {s.notObservedCount > 0 ? (
                <span className="inline-flex items-center gap-0.5 font-medium opacity-80">
                  <EyeOff className="h-3 w-3" />
                  {t('activity.ai_assessments.not_observed_count', { count: s.notObservedCount })}
                </span>
              ) : null}
            </span>
          </button>
        </h3>
        {expanded ? (
          <div id={panelId} className="flex flex-col gap-2 bg-white p-2 dark:bg-gray-900">
            <p className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-gray-500 dark:text-gray-400">
              <History className="h-3.5 w-3.5 shrink-0" />
              {t('activity.ai_assessments.scored_at', { when: when(s.runAt), name: s.runByName ?? '—', version: s.assessmentVersion })}
            </p>
            {changed ? (
              <p className="flex items-start gap-1.5 px-1 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('activity.ai_assessments.rubric_changed', { version: s.currentVersion })}
              </p>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {s.criteria.map((c, i) => (
                <li key={`${c.criterionId ?? 'c'}-${i}`} className="rounded-md border border-gray-100 px-3 py-2 text-sm dark:border-gray-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 font-medium text-gray-800 dark:text-gray-100">{c.name}</span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400">{t('activity.ai_assessments.weight', { weight: c.weight })}</span>
                    {c.level === null ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
                        <EyeOff className="h-3 w-3" />
                        {t('activity.ai_assessments.not_observed')}
                      </span>
                    ) : (
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${scoreTone(c.level * 20)}`}>
                        <Gauge className="h-3 w-3" />
                        {t('activity.ai_assessments.level', { level: c.level })}
                      </span>
                    )}
                  </div>
                  {c.rationale ? <p className="mt-1 whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300">{c.rationale}</p> : null}
                  {c.citations.length > 0 ? <div className="mt-1.5 flex flex-wrap items-center gap-1">{c.citations.map(citation)}</div> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorBox message={error} /> : null}

      <div className="rounded-md border border-gray-200 px-3 py-2.5 dark:border-gray-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-xs text-gray-600 dark:text-gray-400">
            <p className="flex items-center gap-1.5">
              <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
              {view.assigned.length > 0
                ? t('activity.ai_assessments.assigned', { names: view.assigned.map((a) => a.name).join(', ') })
                : t('activity.ai_assessments.none_assigned')}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5">
              <EyeOff className="h-3.5 w-3.5 shrink-0" />
              {t('activity.ai_assessments.leaders_only')}
            </p>
          </div>
          {view.assigned.length > 0 ? (
            <Button type="button" size="sm" disabled={!view.canRun || running} onClick={() => void run()} title={blockedText ?? undefined}>
              {running
                ? <Spinner className="mr-1 h-3.5 w-3.5" />
                : view.scores.length > 0 ? <RefreshCw className="mr-1 h-3.5 w-3.5" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              {running ? t('activity.ai_assessments.running') : view.scores.length > 0 ? t('activity.ai_assessments.rerun') : t('activity.ai_assessments.run')}
            </Button>
          ) : null}
        </div>
        {blockedText && view.blockedReason !== 'none_assigned' ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {blockedText}
          </p>
        ) : null}
      </div>

      {view.scores.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center dark:border-gray-600">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('activity.ai_assessments.empty_title')}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('activity.ai_assessments.empty_hint')}</p>
        </div>
      ) : (
        view.scores.map(scoreCard)
      )}
      <p className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
        <Sparkles className="h-3 w-3" />
        {t('activity.ai_assessments.footer')}
      </p>
    </div>
  )
}
