import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { SingleSelect } from '../ui/single-select.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'
import { Spinner } from '../ui/spinner.js'
import { TrendingUp, CalendarClock, CalendarRange, DollarSign } from 'lucide-react'

type Basis = 'close' | 'created'
interface Resp { cfq: number; cfy: number; basis: Basis; snapshotAt: string | null; configured: boolean }

// Modern KPI-card matching the leader dashboards' ColorStatCard: tinted panel,
// rounded icon chip, oversized watermark glyph.
function ImpactCard({ label, value, Icon, color }: {
  label: string; value: React.ReactNode; Icon: React.ComponentType<{ className?: string }>; color: 'emerald' | 'violet'
}) {
  const c = color === 'emerald'
    ? { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-900 dark:text-emerald-100', iconBg: 'bg-emerald-100 dark:bg-emerald-900/60', iconFg: 'text-emerald-600 dark:text-emerald-300', watermark: 'text-emerald-200 dark:text-emerald-800/50' }
    : { bg: 'bg-violet-50 dark:bg-violet-950/40', text: 'text-violet-900 dark:text-violet-100', iconBg: 'bg-violet-100 dark:bg-violet-900/60', iconFg: 'text-violet-600 dark:text-violet-300', watermark: 'text-violet-200 dark:text-violet-800/50' }
  return (
    <div className={`relative flex items-start gap-3 overflow-hidden rounded-xl border border-transparent p-4 ${c.bg}`}>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${c.iconBg}`}>
        <Icon className={`h-5 w-5 ${c.iconFg}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold uppercase tracking-wide ${c.text}`}>{label}</p>
        <p className={`mt-1 text-xl font-bold leading-tight ${c.text}`}>{value}</p>
      </div>
      <Icon className={`pointer-events-none absolute -right-2 -top-2 h-16 w-16 opacity-30 ${c.watermark}`} />
    </div>
  )
}

// A running total of the signed-in user's ACV impact — Σ Total_Acv__c over
// every opportunity they're attached to (Assigned SE or an Evaluation
// engineer role), deduplicated — for the current fiscal quarter and year.
// Backed by the local coverage snapshot, so it's one cheap request. The
// Close / Created toggle picks which opportunity date places a deal in the
// period. Values honor the user's "Show Costs In" currency (My Settings) via
// the surrounding DisplayCurrencyProvider. Hidden when the team hasn't
// configured attach-rate role fields.
export function AcvImpactTiles() {
  const { t } = useTranslation()
  const { fmt } = useDisplayCurrency()
  const [basis, setBasis] = useState<Basis>(() => {
    try { return localStorage.getItem('weekly.acvImpact.basis') === 'created' ? 'created' : 'close' } catch { return 'close' }
  })
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    try { localStorage.setItem('weekly.acvImpact.basis', basis) } catch { /* ignore */ }
  }, [basis])

  useEffect(() => {
    let live = true
    setLoading(true)
    api.get<Resp>(`/api/dashboards/my-acv-impact?basis=${basis}`)
      .then((res) => { if (live) setData(res.data ?? null) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [basis])

  // Team not configured for attach-rate roles → nothing to show.
  if (!loading && data && !data.configured) return null

  const snapshotLabel = data?.snapshotAt ? new Date(data.snapshotAt).toLocaleDateString() : null

  return (
    <div className="mt-3 space-y-2 px-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <TrendingUp className="h-3.5 w-3.5" />
          {t('weekly.acv_impact.title', 'ACV Impact')}
        </h3>
        <SingleSelect
          label={t('weekly.acv_impact.basis_label', 'Period By')}
          labelIcon={CalendarClock}
          value={basis}
          onChange={(v) => setBasis(v as Basis)}
          options={[
            { value: 'close', label: t('weekly.acv_impact.basis_close', 'Close Date') },
            { value: 'created', label: t('weekly.acv_impact.basis_created', 'Created Date') },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ImpactCard
          color="emerald"
          Icon={CalendarRange}
          label={t('weekly.acv_impact.cfq', 'ACV Impact CFQ')}
          value={loading ? <Spinner className="h-4 w-4" /> : fmt(data?.cfq ?? 0)}
        />
        <ImpactCard
          color="violet"
          Icon={DollarSign}
          label={t('weekly.acv_impact.cfy', 'ACV Impact CFY')}
          value={loading ? <Spinner className="h-4 w-4" /> : fmt(data?.cfy ?? 0)}
        />
      </div>
      {snapshotLabel && (
        <p className="text-[10px] text-gray-400 dark:text-gray-500">{t('weekly.acv_impact.as_of', 'As of {{date}}', { date: snapshotLabel })}</p>
      )}
    </div>
  )
}
