import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Select } from '../ui/select.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { useTeam } from '../../hooks/useTeam.js'
import { api } from '../../lib/api.js'

interface ImportRow { index: number; raw: Record<string, string>; errors: string[]; activity?: unknown }
interface ImportResult {
  summary: { total: number; ready: number; errored: number; inserted: number }
  rows: ImportRow[]
}

const SAMPLE_CSV = `date,time,duration_hours,activity_type,title,notes,status
2026-07-06,09:00,1.5,Demo,Weekly sync — Acme Corp,Discussed rollout plan,submitted
2026-07-06,14:00,2,Discovery,Beta Systems intro,Meet PoC contacts,draft`

export function CsvImportSection({ adminMode = false }: { adminMode?: boolean }) {
  const { t } = useTranslation()
  const { activeTeam, teams } = useTeam()
  const [teamId, setTeamId] = useState<string>(activeTeam?.id ?? '')
  const [csv, setCsv] = useState<string>('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [loading, setLoading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => setCsv(String(reader.result ?? ''))
    reader.readAsText(f)
  }

  async function run(dryRun: boolean) {
    if (!teamId || !csv) return
    setLoading(true); setResult(null)
    const url = adminMode ? '/api/admin/activities/import' : '/api/activities/import'
    const res = await api.post<ImportResult>(url, { teamId, csv, dryRun })
    setLoading(false)
    setResult(res.data ?? null)
  }

  const teamOptions = teams ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label>{t('settings.csv_import.team_label')}</Label>
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">{t('settings.csv_import.pick_team')}</option>
            {teamOptions.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('settings.csv_import.file_label')}</Label>
          <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={onFile} className="text-xs" />
        </div>
      </div>
      <details className="text-xs text-gray-500 dark:text-gray-400">
        <summary className="cursor-pointer">{t('settings.csv_import.format_help')}</summary>
        <pre className="mt-2 overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-2 text-[10px]">{SAMPLE_CSV}{adminMode ? '\n\n(Add a user_email column to assign rows to specific team members.)' : ''}</pre>
      </details>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => run(true)} disabled={!teamId || !csv || loading}>{loading ? <Spinner className="h-3 w-3" /> : t('settings.csv_import.preview')}</Button>
        <Button size="sm" onClick={() => run(false)} disabled={!teamId || !csv || loading}><Upload className="mr-1 h-3 w-3" />{t('settings.csv_import.import')}</Button>
      </div>
      {result && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
          <p className="mb-2 text-sm font-medium">
            {t('settings.csv_import.summary', {
              total: result.summary.total,
              ready: result.summary.ready,
              errored: result.summary.errored,
              inserted: result.summary.inserted,
            })}
          </p>
          {result.rows.some((r) => r.errors.length > 0) && (
            <div className="max-h-64 overflow-y-auto rounded bg-white dark:bg-gray-900 p-2 text-xs">
              <p className="mb-1 font-semibold text-red-700 dark:text-red-400">{t('settings.csv_import.errors')}</p>
              <ul className="flex flex-col gap-0.5">
                {result.rows.filter((r) => r.errors.length > 0).map((r) => (
                  <li key={r.index} className="font-mono">
                    <span className="text-gray-500">row {r.index}:</span> {r.errors.join(' · ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
