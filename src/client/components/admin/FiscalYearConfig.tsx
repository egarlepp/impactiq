import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { addMonths, format } from 'date-fns'
import { Calendar, Info, Save } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { cn } from '../../lib/utils.js'

interface FiscalConfig {
  mode: 'calendar' | 'fiscal'
  startMonth: number
  yearNaming: 'same' | 'next'
}

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function fiscalLabel(date: Date, cfg: FiscalConfig): string {
  const m = date.getMonth() + 1
  const y = date.getFullYear()
  if (cfg.mode === 'calendar') return `Q${Math.ceil(m / 3)} ${y}`
  const monthsFromStart = (m - cfg.startMonth + 12) % 12
  const q = Math.floor(monthsFromStart / 3) + 1
  const fiscalStartYear = m >= cfg.startMonth ? y : y - 1
  const labelYear = cfg.yearNaming === 'next' ? fiscalStartYear + 1 : fiscalStartYear
  return `Q${q} FY${String(labelYear).slice(-2)}`
}

export function FiscalYearConfig() {
  const { t } = useTranslation()
  const [cfg, setCfg] = useState<FiscalConfig>({ mode: 'calendar', startMonth: 1, yearNaming: 'same' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    api.get<FiscalConfig>('/api/admin/fiscal-year').then((res) => {
      if (res.data) setCfg(res.data)
      setLoading(false)
    })
  }, [])

  const now = useMemo(() => new Date(), [])
  const plus3 = useMemo(() => addMonths(now, 3), [now])
  const minus6 = useMemo(() => addMonths(now, -6), [now])

  async function save() {
    setSaving(true)
    const res = await api.patch<FiscalConfig>('/api/admin/fiscal-year', cfg)
    setSaving(false)
    if (res.data) setSavedAt(Date.now())
  }

  if (loading) return <div className="p-6 text-sm text-gray-500">…</div>

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Calendar className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.fiscal.title')}
        </h2>
      </div>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t('admin.fiscal.description')}</p>
      <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">

      {/* Display mode radio cards */}
      <div className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">{t('admin.fiscal.display_mode')}</div>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t('admin.fiscal.display_mode_hint')}</p>
      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        {(['calendar', 'fiscal'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setCfg((c) => ({ ...c, mode: m }))}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors',
              cfg.mode === m
                ? 'border-blue-500 bg-blue-50/50 ring-2 ring-blue-500/30 dark:border-blue-500 dark:bg-blue-950/30'
                : 'border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600',
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full border',
                  cfg.mode === m ? 'border-blue-600 bg-blue-600' : 'border-gray-300 dark:border-gray-500',
                )}
              >
                {cfg.mode === m && <span className="h-2 w-2 rounded-full bg-white" />}
              </span>
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {m === 'calendar' ? t('admin.fiscal.calendar_year') : t('admin.fiscal.fiscal_year')}
              </span>
            </span>
            <span className="pl-6 text-xs text-gray-500 dark:text-gray-400">
              {m === 'calendar' ? t('admin.fiscal.calendar_year_desc') : t('admin.fiscal.fiscal_year_desc')}
            </span>
            <span className="ml-6 mt-1 inline-block rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              {t('admin.fiscal.example')}: {fiscalLabel(now, { mode: m, startMonth: m === 'fiscal' ? cfg.startMonth : 1, yearNaming: m === 'fiscal' ? cfg.yearNaming : 'same' })}
            </span>
          </button>
        ))}
      </div>

      {cfg.mode === 'fiscal' && (
        <div className="mb-6 grid grid-cols-1 gap-6 border-t border-gray-200 pt-6 md:grid-cols-2 dark:border-gray-700">
          <div>
            <Label className="mb-1 block">{t('admin.fiscal.start_month')}</Label>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.fiscal.start_month_hint')}</p>
            <Select
              value={String(cfg.startMonth)}
              onChange={(e) => setCfg((c) => ({ ...c, startMonth: Number(e.target.value) }))}
              className="w-full"
            >
              {MONTHS.map((mo, i) => (
                <option key={mo} value={i + 1}>{mo}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label className="mb-1 block">{t('admin.fiscal.year_naming')}</Label>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.fiscal.year_naming_hint')}</p>
            <Select
              value={cfg.yearNaming}
              onChange={(e) => setCfg((c) => ({ ...c, yearNaming: e.target.value as 'same' | 'next' }))}
              className="w-full"
            >
              <option value="same">
                {t('admin.fiscal.same_year_option', { month: MONTHS[cfg.startMonth - 1], year: now.getFullYear() })}
              </option>
              <option value="next">
                {t('admin.fiscal.next_year_option', { month: MONTHS[cfg.startMonth - 1], year: now.getFullYear(), fy: `FY${String(now.getFullYear() + 1).slice(-2)}` })}
              </option>
            </Select>
          </div>
        </div>
      )}

      {/* Live preview */}
      <div className="mb-4 border-t border-gray-200 pt-4 dark:border-gray-700">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-200">
          <Info className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
          {t('admin.fiscal.live_preview')}
        </div>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t('admin.fiscal.live_preview_hint')}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            { label: t('admin.fiscal.today'), date: now },
            { label: t('admin.fiscal.plus_3_months'), date: plus3 },
            { label: t('admin.fiscal.minus_6_months'), date: minus6 },
          ].map((p, i) => (
            <div key={i} className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/40">
              <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{p.label}</div>
              <div className="mt-0.5 text-sm text-gray-800 dark:text-gray-100">{format(p.date, 'MMM d, yyyy')}</div>
              <div className="mt-1 flex items-center gap-1 text-xs">
                <span className="text-gray-400">→</span>
                <span className="rounded bg-white px-1.5 py-0.5 text-[11px] font-semibold text-gray-800 shadow-sm dark:bg-gray-900 dark:text-gray-100">
                  {fiscalLabel(p.date, cfg)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-700">
        <Button onClick={save} disabled={saving}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {saving ? '…' : t('admin.fiscal.save')}
        </Button>
        {savedAt && Date.now() - savedAt < 4000 && (
          <span className="text-xs text-green-600 dark:text-green-400">{t('admin.fiscal.saved')}</span>
        )}
      </div>

      <div className="mt-6 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <div className="font-semibold">{t('admin.fiscal.affects_title')}</div>
          <div>{t('admin.fiscal.affects_desc')}</div>
        </div>
      </div>
      </div>
    </section>
  )
}
