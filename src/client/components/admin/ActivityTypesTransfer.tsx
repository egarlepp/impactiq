import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload, X, CheckCircle2, AlertTriangle, Plus, Pencil, Tags, PlugZap, ClipboardCheck, Link2 } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'

// v1.374.0: Export / Import for Admin → Activity Types. The server does all
// the matching (services/teams/activityTypesTransfer.ts); this component
// only downloads the export, uploads a file for a preview diff, and applies
// it once the admin confirms.

interface ActivityTypesDocument {
  kind: string
  formatVersion: number
  exportedAt: string
  exportedByEmail?: string | null
  sourceTeamSlug?: string
  sourceTeamName?: string
  activityTypes: unknown[]
}

interface ImportDiff {
  toCreate: Array<{ name: string; subtypes: number; sfExtras: number }>
  toUpdate: Array<{
    name: string
    changes?: Array<{ field: string; from: unknown; to: unknown }>
    subtypesAdded?: string[]
    extrasReplaced?: { from: number; to: number }
  }>
  unchanged: string[]
  skippedShared: string[]
  notInFile: string[]
  duplicateNamesInFile: string[]
  teamChanges: Array<{ field: string; from: unknown; to: unknown }>
  aiAssessments: AssessmentsDiff | null
}

interface AssignmentRef { assessment: string; activityType: string; subtype: string | null }
interface AssessmentsDiff {
  toCreate: string[]
  toUpdate: Array<{ name: string; fields: string[] }>
  unchanged: string[]
  skipped: Array<{ name: string; reason: 'shared' | 'locked' }>
  duplicateNamesInFile: string[]
  assignmentsToAdd: AssignmentRef[]
  assignmentsSkipped: Array<AssignmentRef & { reason: 'missing_type' | 'missing_subtype' | 'slot_full' }>
}

interface ImportResult {
  created: number
  updated: number
  unchanged: number
  skipped: number
  subtypesAdded: number
  teamSettingsUpdated: boolean
  assessmentsCreated: number
  assessmentsUpdated: number
  assignmentsAdded: number
}

const EXPORT_KIND = 'impactiq.activity_types'

// Long free-text fields (Guide text) would swamp the diff, so the preview
// shows them as "changed" rather than printing both values in full.
const LONG_FIELDS = new Set(['useThisWhen', 'usuallyAttachTo', 'examples', 'guideDistinctions'])

export function ActivityTypesTransfer({ teamId, onApplied }: { teamId: string; onApplied: () => Promise<void> | void }) {
  const { t } = useTranslation()
  const [exporting, setExporting] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [doc, setDoc] = useState<ActivityTypesDocument | null>(null)
  const [diff, setDiff] = useState<ImportDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleExport() {
    setExporting(true)
    setError(null)
    const res = await api.get<ActivityTypesDocument>(`/api/admin/teams/${teamId}/activity-types/export`)
    setExporting(false)
    if (!res.data) { setError(res.error ? t(res.error) : t('admin.activity_types.transfer.export_failed')); return }
    const slug = res.data.sourceTeamSlug ?? 'team'
    const date = new Date().toISOString().slice(0, 10)
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `activity-types-${slug}-${date}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setResult(null)
    setDiff(null)
    setDoc(null)
    let parsed: ActivityTypesDocument
    try {
      parsed = JSON.parse(await file.text()) as ActivityTypesDocument
    } catch {
      setError(t('admin.activity_types.transfer.invalid_file'))
      return
    }
    if (parsed?.kind !== EXPORT_KIND || parsed.formatVersion !== 1 || !Array.isArray(parsed.activityTypes)) {
      setError(t('admin.activity_types.transfer.invalid_format'))
      return
    }
    setPreviewLoading(true)
    const res = await api.post<ImportDiff>(`/api/admin/teams/${teamId}/activity-types/import/preview`, { document: parsed })
    setPreviewLoading(false)
    if (res.error || !res.data) {
      setError(res.error ? t(res.error) : t('admin.activity_types.transfer.preview_failed'))
      return
    }
    setDoc(parsed)
    setDiff(res.data)
  }

  async function applyImport() {
    if (!doc) return
    setApplying(true)
    setError(null)
    const res = await api.post<ImportResult>(`/api/admin/teams/${teamId}/activity-types/import/apply`, { document: doc })
    setApplying(false)
    if (res.error || !res.data) {
      setError(res.error ? t(res.error) : t('admin.activity_types.transfer.apply_failed'))
      return
    }
    setResult(res.data)
    setDoc(null)
    setDiff(null)
    await onApplied()
  }

  function close() {
    setDoc(null)
    setDiff(null)
    setError(null)
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => void handleExport()} disabled={exporting}>
        {exporting ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Download className="mr-1 h-3.5 w-3.5" />}
        {t('admin.activity_types.transfer.export')}
      </Button>
      <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={previewLoading}>
        {previewLoading ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
        {t('admin.activity_types.transfer.import')}
      </Button>
      <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void handleFileSelected(e)} />

      {(error && !doc) && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 shadow dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label={t('common.close')} title={t('common.close')}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {result && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 shadow dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t('admin.activity_types.transfer.applied', result as unknown as Record<string, unknown>)}
            {(result.assessmentsCreated > 0 || result.assessmentsUpdated > 0 || result.assignmentsAdded > 0) && (
              <> {t('admin.activity_types.transfer.assessments_applied', { created: result.assessmentsCreated, updated: result.assessmentsUpdated, assigned: result.assignmentsAdded })}</>
            )}
          </span>
          <button onClick={() => setResult(null)} aria-label={t('common.close')} title={t('common.close')}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {doc && diff && (
        <PreviewModal doc={doc} diff={diff} applying={applying} error={error} onApply={() => void applyImport()} onClose={close} />
      )}
    </>
  )
}

function fmt(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string' && LONG_FIELDS.has(field)) return v.length > 40 ? `${v.slice(0, 40)}…` : v
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function ChangeList({ changes }: { changes: Array<{ field: string; from: unknown; to: unknown }> }) {
  const { t } = useTranslation()
  return (
    <ul className="mt-1 flex flex-col gap-0.5 pl-2 text-[11px] text-gray-600 dark:text-gray-400">
      {changes.map((c, i) => (
        <li key={i}>
          <span className="font-medium">{t(`admin.activity_types.transfer.fields.${c.field}`, c.field)}:</span>{' '}
          {c.field === 'subtypeOrder' ? (
            <span>{t('admin.activity_types.transfer.reordered')}</span>
          ) : (
            <>
              <span className="text-red-600 dark:text-red-400">{fmt(c.field, c.from)}</span>{' → '}
              <span className="text-green-700 dark:text-green-400">{fmt(c.field, c.to)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

function PreviewModal({ doc, diff, applying, error, onApply, onClose }: {
  doc: ActivityTypesDocument
  diff: ImportDiff
  applying: boolean
  error: string | null
  onApply: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const a = diff.aiAssessments
  const hasChanges = diff.toCreate.length > 0 || diff.toUpdate.length > 0 || diff.teamChanges.length > 0
    || (!!a && (a.toCreate.length > 0 || a.toUpdate.length > 0 || a.assignmentsToAdd.length > 0))
  const unknown = t('admin.activity_types.transfer.unknown')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Upload className="h-4 w-4" />
            {t('admin.activity_types.transfer.preview_title')}
          </p>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label={t('common.close')} title={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.activity_types.transfer.preview_source', {
            when: new Date(doc.exportedAt).toLocaleString(),
            who: doc.exportedByEmail ?? unknown,
            team: doc.sourceTeamName ?? doc.sourceTeamSlug ?? unknown,
          })}
        </p>

        {diff.toCreate.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400">
              <Plus className="h-3.5 w-3.5" />
              {t('admin.activity_types.transfer.to_create', { count: diff.toCreate.length })}
            </p>
            <ul className="flex flex-col gap-0.5 text-xs text-gray-600 dark:text-gray-400">
              {diff.toCreate.map((r) => (
                <li key={r.name}>
                  <span className="font-medium text-gray-800 dark:text-gray-200">{r.name}</span>{' '}
                  <span className="text-gray-400">{t('admin.activity_types.transfer.create_detail', { subtypes: r.subtypes, extras: r.sfExtras })}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {diff.toUpdate.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
              <Pencil className="h-3.5 w-3.5" />
              {t('admin.activity_types.transfer.to_update', { count: diff.toUpdate.length })}
            </p>
            <ul className="flex flex-col gap-2 text-xs">
              {diff.toUpdate.map((r) => (
                <li key={r.name} className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-900 dark:bg-amber-950/30">
                  <span className="font-medium text-gray-800 dark:text-gray-200">{r.name}</span>
                  {r.changes && <ChangeList changes={r.changes} />}
                  {r.subtypesAdded && (
                    <p className="mt-1 flex items-center gap-1 pl-2 text-[11px] text-gray-600 dark:text-gray-400">
                      <Tags className="h-3 w-3" />
                      {t('admin.activity_types.transfer.subtypes_added', { names: r.subtypesAdded.join(', ') })}
                    </p>
                  )}
                  {r.extrasReplaced && (
                    <p className="mt-1 flex items-center gap-1 pl-2 text-[11px] text-gray-600 dark:text-gray-400">
                      <PlugZap className="h-3 w-3" />
                      {t('admin.activity_types.transfer.extras_replaced', r.extrasReplaced)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {diff.teamChanges.length > 0 && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-900 dark:bg-amber-950/30">
            <span className="font-medium text-gray-800 dark:text-gray-200">{t('admin.activity_types.transfer.team_settings')}</span>
            <ChangeList changes={diff.teamChanges} />
          </div>
        )}

        {a && <AssessmentsSection diff={a} />}

        {diff.skippedShared.length > 0 && (
          <p className="mb-2 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {t('admin.activity_types.transfer.skipped_shared', { names: diff.skippedShared.join(', ') })}
          </p>
        )}
        {diff.duplicateNamesInFile.length > 0 && (
          <p className="mb-2 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {t('admin.activity_types.transfer.duplicates', { names: diff.duplicateNamesInFile.join(', ') })}
          </p>
        )}
        {diff.unchanged.length > 0 && (
          <p className="mb-2 text-xs text-gray-400">{t('admin.activity_types.transfer.unchanged', { count: diff.unchanged.length })}</p>
        )}
        {diff.notInFile.length > 0 && (
          <p className="mb-2 text-xs text-gray-400">{t('admin.activity_types.transfer.not_in_file', { count: diff.notInFile.length, names: diff.notInFile.join(', ') })}</p>
        )}
        <p className="mb-2 text-xs text-gray-400">{t('admin.activity_types.transfer.mappings_note')}</p>
        {!hasChanges && <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.activity_types.transfer.nothing_to_do')}</p>}

        {error && (
          <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{error}</p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
          <Button size="sm" onClick={onApply} disabled={applying || !hasChanges}>
            {applying ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
            {t('admin.activity_types.transfer.apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}

const slotLabel = (r: AssignmentRef) => (r.subtype ? `${r.activityType} → ${r.subtype}` : r.activityType)

function AssessmentsSection({ diff }: { diff: AssessmentsDiff }) {
  const { t } = useTranslation()
  const empty = diff.toCreate.length + diff.toUpdate.length + diff.unchanged.length + diff.skipped.length + diff.assignmentsToAdd.length + diff.assignmentsSkipped.length === 0
  if (empty) return null
  return (
    <div className="mb-3 rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-xs dark:border-violet-900 dark:bg-violet-950/30">
      <p className="mb-1 flex items-center gap-1 font-semibold text-violet-800 dark:text-violet-300">
        <ClipboardCheck className="h-3.5 w-3.5" />
        {t('admin.activity_types.transfer.assessments.title')}
      </p>
      <ul className="flex flex-col gap-0.5 text-gray-700 dark:text-gray-300">
        {diff.toCreate.map((n) => (
          <li key={`c-${n}`} className="flex items-center gap-1"><Plus className="h-3 w-3 text-green-600 dark:text-green-400" />{t('admin.activity_types.transfer.assessments.create', { name: n })}</li>
        ))}
        {diff.toUpdate.map((u) => (
          <li key={`u-${u.name}`} className="flex items-center gap-1">
            <Pencil className="h-3 w-3 text-amber-600 dark:text-amber-400" />
            {t('admin.activity_types.transfer.assessments.update', {
              name: u.name,
              fields: u.fields.map((f) => t(`admin.activity_types.transfer.assessments.fields.${f}`)).join(', '),
            })}
          </li>
        ))}
        {diff.assignmentsToAdd.map((r, i) => (
          <li key={`a-${i}`} className="flex items-center gap-1"><Link2 className="h-3 w-3 text-green-600 dark:text-green-400" />{t('admin.activity_types.transfer.assessments.assign', { name: r.assessment, slot: slotLabel(r) })}</li>
        ))}
      </ul>
      {diff.skipped.map((s) => (
        <p key={`s-${s.name}`} className="mt-1 flex items-start gap-1 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {t(`admin.activity_types.transfer.assessments.skipped_${s.reason}`, { name: s.name })}
        </p>
      ))}
      {diff.assignmentsSkipped.map((r, i) => (
        <p key={`k-${i}`} className="mt-1 flex items-start gap-1 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {t(`admin.activity_types.transfer.assessments.assign_${r.reason}`, { name: r.assessment, slot: slotLabel(r) })}
        </p>
      ))}
      {diff.duplicateNamesInFile.length > 0 && (
        <p className="mt-1 flex items-start gap-1 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {t('admin.activity_types.transfer.duplicates', { names: diff.duplicateNamesInFile.join(', ') })}
        </p>
      )}
      {diff.unchanged.length > 0 && (
        <p className="mt-1 text-gray-400">{t('admin.activity_types.transfer.assessments.unchanged', { count: diff.unchanged.length })}</p>
      )}
    </div>
  )
}
