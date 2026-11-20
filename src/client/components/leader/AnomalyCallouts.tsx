import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { format, parseISO } from 'date-fns'
import {
  AlertTriangle, Building2, Briefcase, CheckCircle2, ChevronDown, ChevronRight,
  Info, Radar, Tag, UserRound, Users, XCircle,
} from 'lucide-react'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { InfoPopover } from '../ui/info-popover.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.220.0: anomaly callouts above the leader dashboards.
//
// The dashboards answer the questions a leader already knows to ask. This
// answers the one they don't — "is anything off this week?" — without making
// them sweep thirteen tabs looking for it.
//
// Collapsed state is remembered per browser, not per session, and the panel
// stays mounted even with nothing to report. Both are deliberate: a panel
// that only appears when it has something to say trains people to not look
// for it, and "nothing unusual" is genuinely useful information on a Monday.

type Severity = 'high' | 'medium' | 'low'
type SubjectType = 'account' | 'opportunity' | 'user' | 'activity_type' | 'team'

interface Anomaly {
  code: string
  severity: Severity
  subjectType: SubjectType
  subjectId: string | null
  subjectName: string | null
  params: Record<string, string | number>
  magnitude: number
}

interface AnomalyPayload {
  weekStart: string
  weekEnd: string
  baselineWeeks: number
  baselineWeeksWithData: number
  anomalies: Anomaly[]
  suppressed: number
  insufficientHistory: boolean
}

const STORAGE_KEY = 'leader.anomalies.collapsed'

const SUBJECT_ICON: Record<SubjectType, typeof Building2> = {
  account: Building2,
  opportunity: Briefcase,
  user: UserRound,
  activity_type: Tag,
  team: Users,
}

export function AnomalyCallouts({
  teamId,
  productIds,
}: {
  teamId: string | null
  productIds: string[]
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [data, setData] = useState<AnomalyPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  })

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0') } catch { /* ignore */ }
  }, [collapsed])

  const productKey = productIds.slice().sort().join(',')
  useEffect(() => {
    if (!teamId) { setData(null); return }
    let cancelled = false
    setLoading(true)
    const qs = new URLSearchParams({ teamId })
    if (productKey) qs.set('productIds', productKey)
    void api.get<AnomalyPayload>(`/api/dashboards/anomalies?${qs.toString()}`)
      .then((res) => { if (!cancelled) setData(res.data ?? null) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [teamId, productKey])

  if (!teamId) return null

  const count = data?.anomalies.length ?? 0
  const highest: Severity | null = data?.anomalies[0]?.severity ?? null

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      {/* The header is a row, not one big button: the help popover needs its
          own trigger, and a <button> can't nest inside a <button>. */}
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          {collapsed
            ? <ChevronRight className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
            : <ChevronDown className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />}
          <Radar className="h-4 w-4 shrink-0 text-gray-400" />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('leader.anomalies.title')}
          </span>
        </button>
        <AnomalyHelp />
        {loading ? (
          <span className="text-xs text-gray-400 dark:text-gray-500">{t('leader.anomalies.loading')}</span>
        ) : count > 0 ? (
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
            highest === 'high'
              ? 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300'
              : highest === 'medium'
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
              : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
          )}>
            <AlertTriangle className="h-3 w-3" />
            {t('leader.anomalies.count', { count })}
          </span>
        ) : data ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-950/50 dark:text-green-300">
            <CheckCircle2 className="h-3 w-3" />
            {t('leader.anomalies.none_badge')}
          </span>
        ) : null}
        {data && (
          <span className="ml-auto hidden shrink-0 text-[11px] text-gray-400 sm:block dark:text-gray-500">
            {t('leader.anomalies.window', {
              // v1.226.0: weekStart/weekEnd are now plain 'yyyy-MM-dd'
              // calendar-date strings (see anomalies.ts) — parseISO reads
              // them as a local calendar date with no UTC-instant
              // conversion, so the displayed date can't shift a day
              // backward for viewers west of UTC the way `new Date(...)`
              // did.
              start: format(parseISO(data.weekStart), 'MMM d'),
              end: format(parseISO(data.weekEnd), 'MMM d'),
              weeks: data.baselineWeeks,
            })}
          </span>
        )}
      </div>

      {!collapsed && data && (
        <div className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
          {data.insufficientHistory && (
            // Say this rather than silently running fewer checks — otherwise a
            // new team sees an empty panel and concludes everything is fine.
            <p className="mb-2 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('leader.anomalies.insufficient_history', { weeks: data.baselineWeeksWithData, context: crmCtx })}
            </p>
          )}
          {data.anomalies.length === 0 ? (
            <p className="flex items-center gap-1.5 py-1 text-xs text-gray-500 dark:text-gray-400">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
              {t('leader.anomalies.none', { context: crmCtx })}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.anomalies.map((a, i) => (
                <AnomalyRow key={`${a.code}-${a.subjectId ?? a.subjectName ?? i}`} a={a} />
              ))}
            </ul>
          )}
          {data.suppressed > 0 && (
            <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
              {t('leader.anomalies.suppressed', { count: data.suppressed })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// The six detectors, in the order the explainer lists them. Each row pairs the
// subject icon used in the callouts themselves with a plain-language "what it
// means" line, so a leader can map a message back to the rule that produced it.
const HELP_CHECKS: Array<{ code: string; icon: typeof Building2 }> = [
  { code: 'account_burn_spike', icon: Building2 },
  { code: 'contributor_over_capacity', icon: UserRound },
  { code: 'contributor_logging_stopped', icon: UserRound },
  { code: 'activity_type_shift', icon: Tag },
  { code: 'unlinked_spike', icon: Users },
  { code: 'sync_failures', icon: Users },
]

function AnomalyHelp() {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()

  return (
    <InfoPopover ariaLabel={t('leader.anomalies.help.title')}>
      <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Radar className="h-4 w-4 shrink-0 text-gray-400" />
        {t('leader.anomalies.help.title')}
      </p>
      <p className="mb-2 text-gray-600 dark:text-gray-400">{t('leader.anomalies.help.intro')}</p>

      <p className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
        {t('leader.anomalies.help.window_heading')}
      </p>
      <p className="mb-3 text-gray-600 dark:text-gray-400">{t('leader.anomalies.help.window_body')}</p>

      <p className="mb-1.5 font-semibold text-gray-800 dark:text-gray-200">
        {t('leader.anomalies.help.checks_heading')}
      </p>
      <ul className="mb-3 flex flex-col gap-2">
        {HELP_CHECKS.map(({ code, icon: Icon }) => (
          <li key={code} className="flex items-start gap-2">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-gray-800 dark:text-gray-200">
                {t(`leader.anomalies.help.checks.${code}.name`, { context: crmCtx })}
              </span>
              <span className="block text-gray-600 dark:text-gray-400">
                {t(`leader.anomalies.help.checks.${code}.body`, { context: crmCtx })}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <p className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
        {t('leader.anomalies.help.severity_heading')}
      </p>
      <ul className="mb-3 flex flex-col gap-1">
        <li className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('leader.anomalies.help.severity_high')}</span>
        </li>
        <li className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('leader.anomalies.help.severity_medium')}</span>
        </li>
        <li className="flex items-start gap-1.5 text-gray-600 dark:text-gray-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('leader.anomalies.help.severity_low')}</span>
        </li>
      </ul>

      <p className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
        {t('leader.anomalies.help.quiet_heading')}
      </p>
      <p className="text-gray-600 dark:text-gray-400">{t('leader.anomalies.help.quiet_body')}</p>
    </InfoPopover>
  )
}

function AnomalyRow({ a }: { a: Anomaly }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const Icon = SUBJECT_ICON[a.subjectType] ?? Info
  const tone = a.severity === 'high'
    ? 'text-red-700 dark:text-red-400'
    : a.severity === 'medium'
    ? 'text-amber-700 dark:text-amber-400'
    : 'text-gray-600 dark:text-gray-400'
  const Sev = a.severity === 'high' ? XCircle : a.severity === 'medium' ? AlertTriangle : Info
  return (
    <li className={cn('flex items-start gap-1.5 text-xs', tone)}>
      <Sev className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
      <span className="min-w-0 flex-1">{t(`leader.anomalies.codes.${a.code}`, { ...a.params, context: crmCtx })}</span>
    </li>
  )
}
