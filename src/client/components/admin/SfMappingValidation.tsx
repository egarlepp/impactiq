import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, FlaskConical,
  Info, PlugZap, RefreshCw, Table2, XCircle,
} from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { cn } from '../../lib/utils.js'
import { useCrmViewTranslation } from '../../store/crmProvider.js'

// v1.219.0: pre-flight validation + dry run for the team's SF field mappings.
//
// The problem this solves: a bad mapping row never complains at save time.
// The damage lands hours later as failed write-backs in Sync Issues — or,
// worse, as no error at all, because most mapping mistakes fail silently. A
// `read` direction on `title` produces an Event with a blank Subject; a
// missing `crm_what_id` produces an Event linked to nothing. Both look fine in
// the mappings table and in the sync log.
//
// So this button answers the question the table can't: "if the sync ran right
// now, what would actually reach Salesforce, and what would break?"

type Level = 'error' | 'warning' | 'info'

interface Finding {
  level: Level
  code: string
  sobject: string
  appField: string | null
  crmFieldApi: string | null
  mappingId: string | null
  params: Record<string, string | number>
}

interface PreviewField {
  crmFieldApi: string
  label: string | null
  type: string | null
  value: string
}

interface SobjectResult {
  sobject: string
  mappingCount: number
  activityTypeCount: number
  describeOk: boolean
  findings: Finding[]
  preview: { activityId: string | null; activityTitle: string | null; fields: PreviewField[] } | null
}

interface ValidationResult {
  teamId: string
  checkedAt: string
  connected: boolean
  counts: { error: number; warning: number; info: number }
  sobjects: SobjectResult[]
}

// v1.338.0: on-demand "show me one real record" — see mappingValidation.ts's
// sampleObjectRecord(). Deliberately its own fetch per object, never bundled
// into Run Check, so the live SOQL query only fires when an admin asks.
interface SampleField {
  appField: string
  crmFieldApi: string
  value: string
}
interface SampleResult {
  sobject: string
  connected: boolean
  recordId: string | null
  fields: SampleField[]
}

const LEVEL_ORDER: Level[] = ['error', 'warning', 'info']

export function SfMappingValidation({ teamId, crm }: { teamId: string; crm: 'salesforce' | 'hubspot' }) {
  // Checks the CRM picked on the page's toggle (HubSpot: the portal's
  // properties; Salesforce: the org), and the wording follows it.
  const { t, crmCtx } = useCrmViewTranslation(crm)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ValidationResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [openPreview, setOpenPreview] = useState<Record<string, boolean>>({})
  const [openSample, setOpenSample] = useState<Record<string, boolean>>({})
  const [samples, setSamples] = useState<Record<string, SampleResult | undefined>>({})
  const [sampleLoading, setSampleLoading] = useState<Record<string, boolean>>({})

  async function run() {
    setRunning(true)
    setFailed(false)
    const res = await api.post<ValidationResult>(`/api/admin/teams/${teamId}/sf-field-mappings/validate`, { crm })
    if (res.data) setResult(res.data)
    else { setResult(null); setFailed(true) }
    setRunning(false)
  }

  async function loadSample(sobject: string) {
    setSampleLoading((p) => ({ ...p, [sobject]: true }))
    const res = await api.get<SampleResult>(`/api/admin/teams/${teamId}/sf-field-mappings/sample?sobject=${encodeURIComponent(sobject)}`)
    setSamples((p) => ({ ...p, [sobject]: res.data ?? undefined }))
    setSampleLoading((p) => ({ ...p, [sobject]: false }))
  }

  const clean = result && result.counts.error === 0 && result.counts.warning === 0

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <FlaskConical className="h-4 w-4 shrink-0 text-gray-400" />
            {t('admin.sf_mappings.validate.title')}
          </span>
          <span className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {t('admin.sf_mappings.validate.subtitle', { context: crmCtx })}
          </span>
        </div>
        <Button size="sm" onClick={() => { void run() }} disabled={running}>
          {running ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <FlaskConical className="mr-1 h-3.5 w-3.5" />}
          {t('admin.sf_mappings.validate.run')}
        </Button>
      </div>

      {failed && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          {t('admin.sf_mappings.validate.failed', { context: crmCtx })}
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <CountPill level="error" n={result.counts.error} />
            <CountPill level="warning" n={result.counts.warning} />
            <CountPill level="info" n={result.counts.info} />
            {clean && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-800 dark:bg-green-950/50 dark:text-green-300">
                <CheckCircle2 className="h-3 w-3" />
                {t('admin.sf_mappings.validate.clean')}
              </span>
            )}
            {!result.connected && (
              // The static checks still ran and are still worth reading —
              // say which half is missing rather than hiding the result.
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                <PlugZap className="h-3 w-3" />
                {t('admin.sf_mappings.validate.not_connected', { context: crmCtx })}
              </span>
            )}
            <span className="ml-auto text-gray-400 dark:text-gray-500">
              {t('admin.sf_mappings.validate.checked_at', { time: new Date(result.checkedAt).toLocaleTimeString() })}
            </span>
          </div>

          {result.sobjects.map((s) => (
            <div key={s.sobject} className="rounded-md border border-gray-200 dark:border-gray-700">
              <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
                <span className="font-mono text-xs font-semibold text-gray-700 dark:text-gray-200">{s.sobject}</span>
                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                  {t('admin.sf_mappings.validate.scope', { mappings: s.mappingCount, types: s.activityTypeCount })}
                </span>
                {!s.describeOk && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                    <CircleSlash className="h-3 w-3" />
                    {t('admin.sf_mappings.validate.static_only', { context: crmCtx })}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1 p-3">
                {s.findings.length === 0 ? (
                  <p className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    {t('admin.sf_mappings.validate.no_findings')}
                  </p>
                ) : (
                  LEVEL_ORDER.flatMap((lvl) =>
                    s.findings.filter((f) => f.level === lvl).map((f, i) => (
                      <FindingRow key={`${lvl}-${i}-${f.code}-${f.crmFieldApi ?? ''}`} f={f} crm={crm} />
                    )),
                  )
                )}

                {s.preview && (
                  <div className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-800">
                    <button
                      type="button"
                      onClick={() => setOpenPreview((p) => ({ ...p, [s.sobject]: !p[s.sobject] }))}
                      className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
                    >
                      {openPreview[s.sobject]
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      {t('admin.sf_mappings.validate.preview_title', { count: s.preview.fields.length })}
                    </button>
                    {openPreview[s.sobject] && (
                      <div className="mt-2">
                        {s.preview.activityId ? (
                          <>
                            <p className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">
                              {t('admin.sf_mappings.validate.preview_from', { title: s.preview.activityTitle ?? '' })}
                            </p>
                            {s.preview.fields.length === 0 ? (
                              <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                                <XCircle className="h-3.5 w-3.5 shrink-0" />
                                {t('admin.sf_mappings.validate.preview_empty', { context: crmCtx })}
                              </p>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                                      <th className="pb-1 pr-3 font-medium">{t('admin.sf_mappings.validate.col_field', { context: crmCtx })}</th>
                                      <th className="pb-1 pr-3 font-medium">{t('admin.sf_mappings.validate.col_type')}</th>
                                      <th className="pb-1 font-medium">{t('admin.sf_mappings.validate.col_value')}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {s.preview.fields.map((f) => (
                                      <tr key={f.crmFieldApi} className="border-t border-gray-100 dark:border-gray-800">
                                        <td className="py-1 pr-3 align-top">
                                          <span className="font-mono text-gray-800 dark:text-gray-200">{f.crmFieldApi}</span>
                                          {f.label && (
                                            <span className="block text-[10px] text-gray-400 dark:text-gray-500">{f.label}</span>
                                          )}
                                        </td>
                                        <td className="py-1 pr-3 align-top text-gray-500 dark:text-gray-400">{f.type ?? '—'}</td>
                                        <td className="py-1 align-top break-all text-gray-700 dark:text-gray-300">{f.value}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-xs italic text-gray-400 dark:text-gray-500">
                            {t('admin.sf_mappings.validate.preview_no_activity')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-800">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const next = !openSample[s.sobject]
                        setOpenSample((p) => ({ ...p, [s.sobject]: next }))
                        if (next && !samples[s.sobject] && !sampleLoading[s.sobject]) void loadSample(s.sobject)
                      }}
                      className="flex flex-1 items-center gap-1.5 text-left text-xs font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
                    >
                      {openSample[s.sobject]
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      <Table2 className="h-3.5 w-3.5 shrink-0" />
                      {t('admin.sf_mappings.validate.sample_title', 'Sample record')}
                    </button>
                    {openSample[s.sobject] && (
                      <button
                        type="button"
                        onClick={() => void loadSample(s.sobject)}
                        disabled={sampleLoading[s.sobject]}
                        title={t('admin.sf_mappings.validate.sample_refresh', 'Load another record')}
                        aria-label={t('admin.sf_mappings.validate.sample_refresh', 'Load another record')}
                        className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-200"
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5', sampleLoading[s.sobject] && 'animate-spin')} />
                      </button>
                    )}
                  </div>
                  {openSample[s.sobject] && (
                    <div className="mt-2">
                      {sampleLoading[s.sobject] ? (
                        <Spinner className="h-4 w-4" />
                      ) : !samples[s.sobject] || !samples[s.sobject]!.connected ? (
                        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                          <PlugZap className="h-3.5 w-3.5 shrink-0" />
                          {t('admin.sf_mappings.validate.sample_not_connected', { context: crmCtx })}
                        </p>
                      ) : samples[s.sobject]!.fields.length === 0 ? (
                        <p className="text-xs italic text-gray-400 dark:text-gray-500">
                          {samples[s.sobject]!.recordId == null
                            ? t('admin.sf_mappings.validate.sample_no_record', 'No record found for this object.')
                            : t('admin.sf_mappings.validate.sample_no_fields', 'No mapped fields to show.')}
                        </p>
                      ) : (
                        <>
                          <p className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">
                            {t('admin.sf_mappings.validate.sample_from', { id: samples[s.sobject]!.recordId ?? '' })}
                          </p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                                  <th className="pb-1 pr-3 font-medium">{t('admin.sf_mappings.validate.col_app_field', 'App Field')}</th>
                                  <th className="pb-1 pr-3 font-medium">{t('admin.sf_mappings.validate.col_field', { context: crmCtx })}</th>
                                  <th className="pb-1 font-medium">{t('admin.sf_mappings.validate.col_value')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {samples[s.sobject]!.fields.map((f) => (
                                  <tr key={f.appField} className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="py-1 pr-3 align-top font-mono text-gray-800 dark:text-gray-200">{f.appField}</td>
                                    <td className="py-1 pr-3 align-top font-mono text-gray-500 dark:text-gray-400">{f.crmFieldApi}</td>
                                    <td className="py-1 align-top break-all text-gray-700 dark:text-gray-300">{f.value}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CountPill({ level, n }: { level: Level; n: number }) {
  const { t } = useTranslation()
  if (n === 0) return null
  const style = level === 'error'
    ? 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300'
    : level === 'warning'
    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
    : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  const Icon = level === 'error' ? XCircle : level === 'warning' ? AlertTriangle : Info
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium', style)}>
      <Icon className="h-3 w-3" />
      {t(`admin.sf_mappings.validate.count_${level}`, { count: n })}
    </span>
  )
}

function FindingRow({ f, crm }: { f: Finding; crm: 'salesforce' | 'hubspot' }) {
  const { t, crmCtx } = useCrmViewTranslation(crm)
  const tone = f.level === 'error'
    ? 'text-red-700 dark:text-red-400'
    : f.level === 'warning'
    ? 'text-amber-700 dark:text-amber-400'
    : 'text-gray-500 dark:text-gray-400'
  const Icon = f.level === 'error' ? XCircle : f.level === 'warning' ? AlertTriangle : Info
  return (
    <div className={cn('flex items-start gap-1.5 py-0.5 text-xs', tone)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {t(`admin.sf_mappings.validate.codes.${f.code}`, { ...f.params, context: crmCtx })}
        {f.crmFieldApi && (
          <span className="ml-1 font-mono text-[11px] opacity-70">({f.crmFieldApi})</span>
        )}
      </span>
    </div>
  )
}
