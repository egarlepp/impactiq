import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, ClipboardCheck, EyeOff, Gauge, History, ListChecks, Trash2, Users } from 'lucide-react'
import { format } from 'date-fns'
import { api, localizeError } from '../../lib/api.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { levelBarTone, scoreTone } from '../../lib/assessmentTone.js'
import { Spinner } from '../ui/spinner.js'
import { SingleSelect } from '../ui/single-select.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import type { AiAssessmentDashboardAssessment } from '../../../shared/aiAssessments.js'
import { AI_ASSESSMENT_MAX_LEVEL } from '../../../shared/aiAssessments.js'

interface Props { teamId: string; weeksBack: number; productIds?: string[]; memberIds?: string[] }

// AI Assessment Scores (v1.463.0): the Leader dashboard over the scores AI
// Notes Generate and Run assessment wrote. One assessment at a time: the
// team's two averages (not-observed counted as zero, and observed only with
// the not-observed count beside it), a row per person, the average level per
// criterion and the scored activities. The viewer's own activities are never
// included, the same rule as the drawer's Assessments tab.

function keyOf(a: AiAssessmentDashboardAssessment): string {
  return a.assessmentId ?? `name:${a.name}`
}

function ScorePill({ score, title }: { score: number | null; title?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreTone(score)}`} title={title}>
      <Gauge className="h-3 w-3 shrink-0" />
      {score === null ? '—' : score}
    </span>
  )
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className={`rounded-lg border p-3 ${tone ?? 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950'}`}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs opacity-75">{hint}</div>}
    </div>
  )
}

export function AiAssessmentScores({ teamId, weeksBack, productIds = [], memberIds = [] }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<AiAssessmentDashboardAssessment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState('')

  const productKey = productIds.join(',')
  const memberKey = memberIds.join(',')
  useEffect(() => {
    let stale = false
    setLoading(true)
    setError(null)
    api.get<AiAssessmentDashboardAssessment[]>(buildDashboardUrl('ai-assessments', { teamId, weeksBack, productIds, memberIds }))
      .then((res) => {
        if (stale) return
        setData(res.data ?? null)
        setError(res.error ? localizeError(res.error) : null)
      })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
    // productIds / memberIds are tracked by their joined keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, weeksBack, productKey, memberKey])

  const current = useMemo(() => {
    if (!data || data.length === 0) return null
    return data.find((a) => keyOf(a) === selected) ?? data[0]!
  }, [data, selected])

  const description = (
    <p className="text-sm text-gray-600 dark:text-gray-400">
      {t('leader.ai_assessments.description')}
    </p>
  )

  if (loading) return <div className="space-y-4">{description}<div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div></div>
  if (error) return <div className="space-y-4">{description}<DashboardEmptyState reason="custom" message={error} /></div>
  if (!data || !current) {
    return (
      <div className="space-y-4">
        {description}
        <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.ai_assessments.empty')}</p>
      </div>
    )
  }

  const criteriaCount = current.criteria.length
  return (
    <div className="space-y-4">
      {description}

      <div className="flex flex-wrap items-center gap-2">
        {data.length > 1 && (
          <SingleSelect
            label={t('leader.ai_assessments.select_assessment')}
            labelIcon={ClipboardCheck}
            options={data.map((a) => ({ value: keyOf(a), label: a.name, icon: ClipboardCheck, hint: String(a.scoredCount) }))}
            value={keyOf(current)}
            onChange={setSelected}
          />
        )}
        {data.length === 1 && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
            <ClipboardCheck className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            {current.name}
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <EyeOff className="h-3 w-3" />
          {t('leader.ai_assessments.own_excluded')}
        </span>
      </div>

      {current.assessmentId === null && (
        <div className="flex items-center gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
          {t('leader.ai_assessments.deleted')}
        </div>
      )}
      {current.olderVersionCount > 0 && (
        <div className="flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
          <History className="h-3.5 w-3.5 shrink-0" />
          {t('leader.ai_assessments.older_versions', { count: current.olderVersionCount, total: current.scoredCount })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t('leader.ai_assessments.kpi_scored')} value={String(current.scoredCount)} hint={t('leader.ai_assessments.kpi_scored_hint', { count: current.people.length })} />
        <Kpi label={t('leader.ai_assessments.kpi_zeroed')} value={current.avgZeroed === null ? '—' : String(current.avgZeroed)} hint={t('leader.ai_assessments.kpi_zeroed_hint')} tone={scoreTone(current.avgZeroed)} />
        <Kpi label={t('leader.ai_assessments.kpi_observed')} value={current.avgObserved === null ? '—' : String(current.avgObserved)} hint={t('leader.ai_assessments.kpi_observed_hint')} tone={scoreTone(current.avgObserved)} />
        <Kpi label={t('leader.ai_assessments.kpi_not_observed')} value={String(current.avgNotObserved)} hint={t('leader.ai_assessments.kpi_not_observed_hint', { count: criteriaCount })} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-center gap-1.5 border-b border-gray-200 px-3 py-2 text-sm font-medium text-gray-800 dark:border-gray-800 dark:text-gray-100">
            <Users className="h-4 w-4" />
            {t('leader.ai_assessments.people_title')}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_person')}</th>
                <th className="px-3 py-2 text-right">{t('leader.ai_assessments.col_scored')}</th>
                <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_zeroed')}</th>
                <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_observed')}</th>
                <th className="px-3 py-2 text-right">{t('leader.ai_assessments.col_not_observed')}</th>
              </tr>
            </thead>
            <tbody>
              {current.people.map((p) => (
                <tr key={p.userId} className="border-t border-gray-100 dark:border-gray-900">
                  <td className="px-3 py-2 text-gray-800 dark:text-gray-100">{p.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">{p.scoredCount}</td>
                  <td className="px-3 py-2"><ScorePill score={p.avgZeroed} title={t('leader.ai_assessments.kpi_zeroed_hint')} /></td>
                  <td className="px-3 py-2"><ScorePill score={p.avgObserved} title={t('leader.ai_assessments.kpi_observed_hint')} /></td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">{p.avgNotObserved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-center gap-1.5 border-b border-gray-200 px-3 py-2 text-sm font-medium text-gray-800 dark:border-gray-800 dark:text-gray-100">
            <ListChecks className="h-4 w-4" />
            {t('leader.ai_assessments.criteria_title')}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_criterion')}</th>
                <th className="px-3 py-2 text-right">{t('leader.ai_assessments.col_weight')}</th>
                <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_avg_level')}</th>
                <th className="px-3 py-2 text-right">{t('leader.ai_assessments.col_observed_rate')}</th>
              </tr>
            </thead>
            <tbody>
              {current.criteria.map((c) => {
                const pct = c.avgLevel === null ? 0 : Math.round((c.avgLevel / AI_ASSESSMENT_MAX_LEVEL) * 100)
                const observedPct = c.scoredCount === 0 ? 0 : Math.round((c.observedCount / c.scoredCount) * 100)
                return (
                  <tr key={c.criterionId} className="border-t border-gray-100 dark:border-gray-900">
                    <td className="px-3 py-2 text-gray-800 dark:text-gray-100">{c.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">{c.weight}</td>
                    <td className="px-3 py-2">
                      {c.avgLevel === null ? (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
                          <EyeOff className="h-3 w-3" />
                          {t('leader.ai_assessments.never_observed')}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                            <div className={`h-full rounded-full ${levelBarTone(c.avgLevel)}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs tabular-nums text-gray-600 dark:text-gray-300">{t('leader.ai_assessments.level_of', { level: c.avgLevel, max: AI_ASSESSMENT_MAX_LEVEL })}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300" title={t('leader.ai_assessments.observed_rate_hint', { observed: c.observedCount, total: c.scoredCount })}>
                      {observedPct}%
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 text-sm font-medium text-gray-800 dark:border-gray-800 dark:text-gray-100">
          <span className="inline-flex items-center gap-1.5">
            <ClipboardCheck className="h-4 w-4" />
            {t('leader.ai_assessments.activities_title')}
          </span>
          {current.activities.length < current.scoredCount && (
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
              {t('leader.ai_assessments.activities_more', { shown: current.activities.length, total: current.scoredCount })}
            </span>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_activity')}</th>
              <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_owner')}</th>
              <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_date')}</th>
              <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_zeroed')}</th>
              <th className="px-3 py-2 text-left">{t('leader.ai_assessments.col_observed')}</th>
              <th className="px-3 py-2 text-right">{t('leader.ai_assessments.col_not_observed')}</th>
            </tr>
          </thead>
          <tbody>
            {current.activities.map((a) => {
              const dayKey = format(new Date(a.startDatetime), 'yyyy-MM-dd')
              const older = current.currentVersion !== null && a.assessmentVersion < current.currentVersion
              return (
                <tr key={a.activityId} className="border-t border-gray-100 dark:border-gray-900">
                  <td className="px-3 py-2">
                    <a
                      href={`/activities?openActivityId=${a.activityId}&startDate=${dayKey}`}
                      className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {a.title}
                      <ArrowUpRight className="h-3 w-3 shrink-0" />
                    </a>
                    {older && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400" title={t('leader.ai_assessments.older_version_hint')}>
                        <History className="h-3 w-3" />
                        {t('leader.ai_assessments.version', { version: a.assessmentVersion })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{a.ownerName}</td>
                  <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">{dayKey}</td>
                  <td className="px-3 py-2"><ScorePill score={a.zeroed} title={t('leader.ai_assessments.kpi_zeroed_hint')} /></td>
                  <td className="px-3 py-2"><ScorePill score={a.observed} title={t('leader.ai_assessments.kpi_observed_hint')} /></td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">
                    {t('leader.ai_assessments.not_observed_of', { count: a.notObservedCount, total: a.criteriaCount })}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
