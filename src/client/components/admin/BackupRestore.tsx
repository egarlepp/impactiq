// Admin → Monitoring & Audit → Backup & Restore (CLAUDE.md §14d). App Admin
// only. Export streams a full database backup as a download; import uploads
// one, shows a preview of what would be replaced, and only restores after
// the admin types the confirmation word.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DatabaseBackup, Download, Upload, BellRing, History, AlertTriangle, XCircle, CheckCircle2, ShieldAlert, X, RotateCcw, Info, KeyRound, LogIn,
} from 'lucide-react'
import { api, localizeError, readCsrfCookie, type ApiResponse } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Spinner } from '../ui/spinner.js'
import { SingleSelect } from '../ui/single-select.js'
import { BACKUP_REMINDER_DAY_OPTIONS, type BackupReminderDays } from '../../../shared/healthOverview.js'

interface Info {
  appVersion: string
  schema: { lastMigration: string; migrationCount: number }
  tableCount: number
  totalRows: number
  maxUploadMb: number
  // v1.444.0: App Health reminds admins once the last backup is this old.
  lastBackupAt: string | null
  reminderDays: BackupReminderDays
}
interface Issue { code: string; params?: Record<string, string | number> }
interface Preview {
  header: { appVersion: string; createdAt: string; schema: { lastMigration: string } }
  tables: { table: string; backupRows: number; currentRows: number }[]
  errors: Issue[]
  warnings: Issue[]
  adminsInBackup: { email: string; displayName: string }[]
  importerInBackup: boolean
  keyMatches: boolean
}

const CONFIRM_WORD = 'RESTORE'

export function BackupRestore() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<Info | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ token: string; preview: Preview; fileName: string } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadInfo = useCallback(async () => {
    const res = await api.get<Info>('/api/admin/backup/info')
    if (res.error) setInfoError(res.error)
    else setInfo(res.data)
  }, [])
  useEffect(() => { void loadInfo() }, [loadInfo])

  const onExport = () => {
    // A plain navigation lets the browser stream the download to disk
    // instead of buffering the whole database in page memory.
    window.location.assign('/api/admin/backup/export')
    // The server records the time once the file is written; pick it up.
    const before = info?.lastBackupAt ?? null
    let tries = 0
    const poll = window.setInterval(() => {
      tries++
      void api.get<Info>('/api/admin/backup/info').then((res) => {
        if (res.data && (res.data.lastBackupAt !== before || tries >= 12)) {
          setInfo(res.data)
          window.clearInterval(poll)
        } else if (tries >= 12) window.clearInterval(poll)
      })
    }, 5000)
  }

  const [reminderError, setReminderError] = useState<string | null>(null)
  const onReminder = async (value: string) => {
    const days = Number(value) as BackupReminderDays
    setReminderError(null)
    const res = await api.put<{ reminderDays: BackupReminderDays }>('/api/admin/backup/reminder', { days })
    if (res.error) setReminderError(res.error)
    else setInfo((prev) => (prev ? { ...prev, reminderDays: days } : prev))
  }

  const onFile = async (file: File) => {
    setUploadError(null)
    setRestoreError(null)
    setPending(null)
    setConfirmText('')
    setUploading(true)
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      }
      const csrf = readCsrfCookie()
      if (csrf) headers['X-CSRF-Token'] = csrf
      let json: ApiResponse<{ token: string; preview: Preview }>
      try {
        const res = await fetch('/api/admin/backup/import', { method: 'POST', headers, body: file })
        json = await res.json() as ApiResponse<{ token: string; preview: Preview }>
        if (!res.ok && !json.error) json = { data: null, error: `HTTP ${res.status}`, meta: {} }
      } catch {
        json = { data: null, error: t('errors.network'), meta: {} }
      }
      if (json.error || !json.data) setUploadError(localizeError(json.error) ?? t('admin.backup.upload_failed'))
      else setPending({ ...json.data, fileName: file.name })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onCancel = async () => {
    if (pending) await api.delete(`/api/admin/backup/import/${pending.token}`)
    setPending(null)
    setConfirmText('')
    setRestoreError(null)
  }

  const onRestore = async () => {
    if (!pending) return
    setRestoring(true)
    setRestoreError(null)
    const res = await api.post<{ signedOut: boolean }>(`/api/admin/backup/import/${pending.token}/apply`, { confirmation: confirmText })
    setRestoring(false)
    if (res.error) { setRestoreError(res.error); return }
    setRestored(true)
  }

  const issueText = (i: Issue) => t(`admin.backup.issue.${i.code}`, i.params ?? {})
  const fmt = (n: number) => n.toLocaleString()

  if (restored) {
    return (
      <div className="flex flex-col gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-6 dark:border-emerald-900/50 dark:bg-emerald-950/30">
        <div className="flex items-center gap-2 text-lg font-semibold text-emerald-800 dark:text-emerald-200">
          <CheckCircle2 className="h-5 w-5" />
          {t('admin.backup.restored_title')}
        </div>
        <p className="text-sm text-emerald-900 dark:text-emerald-100">{t('admin.backup.restored_body')}</p>
        <div>
          <Button onClick={() => window.location.assign('/login')}>
            <LogIn className="mr-1.5 h-4 w-4" />
            {t('admin.backup.go_to_sign_in')}
          </Button>
        </div>
      </div>
    )
  }

  const blocked = !!pending && pending.preview.errors.length > 0
  const changedTables = pending ? pending.preview.tables.filter((r) => r.backupRows > 0 || r.currentRows > 0) : []

  return (
    <div className="flex flex-col gap-6">
      {/* What's in / out of a backup */}
      <div className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex flex-col gap-1.5">
          <p>{t('admin.backup.intro_included')}</p>
          <p>{t('admin.backup.intro_excluded')}</p>
          <p className="flex items-start gap-1.5"><KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('admin.backup.intro_key')}</p>
          <p className="flex items-start gap-1.5"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('admin.backup.intro_sensitive')}</p>
        </div>
      </div>

      {/* Export */}
      <section className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          <Download className="h-4 w-4" />
          {t('admin.backup.export_title')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('admin.backup.export_body')}</p>
        {infoError && <p className="text-sm text-red-600 dark:text-red-400">{infoError}</p>}
        {info && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.backup.export_summary', { version: info.appVersion, schema: info.schema.lastMigration, tables: fmt(info.tableCount), rows: fmt(info.totalRows) })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onExport}>
            <DatabaseBackup className="mr-1.5 h-4 w-4" />
            {t('admin.backup.export_button')}
          </Button>
          {info && (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <History className="h-3.5 w-3.5" />
                {info.lastBackupAt
                  ? t('admin.backup.last_backup', { time: new Date(info.lastBackupAt).toLocaleString() })
                  : t('admin.backup.last_backup_never')}
              </span>
              <SingleSelect
                label={t('admin.backup.remind_after')}
                labelIcon={BellRing}
                value={String(info.reminderDays)}
                onChange={(v) => { void onReminder(v) }}
                options={BACKUP_REMINDER_DAY_OPTIONS.map((d) => ({ value: String(d), label: t(`admin.backup.remind_choice.${d}`) }))}
              />
            </>
          )}
        </div>
        {reminderError && <p className="text-sm text-red-600 dark:text-red-400">{reminderError}</p>}
      </section>

      {/* Import */}
      <section className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          <Upload className="h-4 w-4" />
          {t('admin.backup.import_title')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('admin.backup.import_body')}</p>
        {info && <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.backup.import_limit', { mb: fmt(info.maxUploadMb) })}</p>}
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.iqbackup,application/gzip"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f) }}
        />
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading || restoring}>
            {uploading ? <Spinner className="mr-1.5 h-4 w-4" /> : <Upload className="mr-1.5 h-4 w-4" />}
            {uploading ? t('admin.backup.checking_file') : t('admin.backup.choose_file')}
          </Button>
        </div>
        {uploadError && (
          <p className="flex items-start gap-1.5 text-sm text-red-600 dark:text-red-400"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{uploadError}</p>
        )}

        {pending && (
          <div className="mt-2 flex flex-col gap-4 border-t border-gray-200 pt-4 dark:border-gray-700">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              {t('admin.backup.preview_file', {
                file: pending.fileName,
                version: pending.preview.header.appVersion,
                date: new Date(pending.preview.header.createdAt).toLocaleString(),
              })}
            </div>

            {pending.preview.errors.map((e, i) => (
              <div key={`e${i}`} className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />{issueText(e)}
              </div>
            ))}
            {pending.preview.warnings.map((w, i) => (
              <div key={`w${i}`} className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{issueText(w)}
              </div>
            ))}

            {pending.preview.adminsInBackup.length > 0 && (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                <div className="font-medium">{t('admin.backup.admins_in_backup')}</div>
                <ul className="ml-5 list-disc">
                  {pending.preview.adminsInBackup.map((a) => <li key={a.email}>{a.displayName} ({a.email})</li>)}
                </ul>
              </div>
            )}

            <div className="max-h-80 overflow-y-auto rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-2">{t('admin.backup.col_table')}</th>
                    <th className="px-3 py-2 text-right">{t('admin.backup.col_current')}</th>
                    <th className="px-3 py-2 text-right">{t('admin.backup.col_backup')}</th>
                  </tr>
                </thead>
                <tbody>
                  {changedTables.map((r) => (
                    <tr key={r.table} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-3 py-1.5 font-mono text-xs text-gray-800 dark:text-gray-200">{r.table}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{fmt(r.currentRows)}</td>
                      <td className="px-3 py-1.5 text-right text-gray-900 dark:text-gray-100">{fmt(r.backupRows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!blocked && (
              <div className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30">
                <p className="flex items-start gap-2 text-sm font-medium text-red-800 dark:text-red-200">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('admin.backup.confirm_warning')}
                </p>
                <label className="text-xs text-red-800 dark:text-red-200" htmlFor="backup-confirm">
                  {t('admin.backup.confirm_label', { word: CONFIRM_WORD })}
                </label>
                <Input
                  id="backup-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={CONFIRM_WORD}
                  className="max-w-xs"
                  autoComplete="off"
                  disabled={restoring}
                />
              </div>
            )}
            {restoreError && (
              <p className="flex items-start gap-1.5 text-sm text-red-600 dark:text-red-400"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{restoreError}</p>
            )}
            <div className="flex items-center gap-2">
              {!blocked && (
                <Button variant="destructive" onClick={onRestore} disabled={restoring || confirmText !== CONFIRM_WORD}>
                  {restoring ? <Spinner className="mr-1.5 h-4 w-4" /> : <RotateCcw className="mr-1.5 h-4 w-4" />}
                  {restoring ? t('admin.backup.restoring') : t('admin.backup.restore_button')}
                </Button>
              )}
              <Button variant="ghost" onClick={onCancel} disabled={restoring}>
                <X className="mr-1.5 h-4 w-4" />
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
