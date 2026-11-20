import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'

interface Row {
  oppId: string
  oppName: string | null
  hours: string
  costDollars: string
  acv: string | null
  activityCount: number
  lastActivityAt: string | null
}

interface Props { teamId: string; weeksBack: number; userId?: string | null; memberIds?: string[]; acv?: string[]; stages?: string[]; forecast?: string[]; productIds?: string[] }


const WIDTH = 640
const HEIGHT = 360
const PAD_LEFT = 70
const PAD_BOTTOM = 40
const PAD_TOP = 20
const PAD_RIGHT = 20

export function OpportunityRoiScatter({ teamId, weeksBack, userId, memberIds, acv = [], stages = [], forecast = [], productIds = [] }: Props) {
  const { t } = useTranslation()
  const { fmt: fmtCurrency, currency } = useDisplayCurrency()
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [hover, setHover] = useState<{ x: number; y: number; row: Row } | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Row[]>(buildDashboardUrl('revenue/opp-roi', { teamId, weeksBack, userId, memberIds, productIds, extra: { acv: acv.length ? acv.join(',') : undefined, stages: stages.length ? stages.join(',') : undefined, forecast: forecast.length ? forecast.join(',') : undefined, displayCurrency: currency !== 'USD' ? currency : undefined } }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, weeksBack, userId, memberIds?.join(','), acv.join(','), stages.join(','), forecast.join(','), productIds.join(','), currency])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />
  const points = data.filter((r) => Number(r.hours) > 0)
  if (points.length === 0) return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>

  const hoursArr = points.map((r) => Number(r.hours))
  const acvArr = points.map((r) => Number(r.acv ?? 0))
  const maxHours = Math.max(...hoursArr, 1)
  const maxAcv = Math.max(...acvArr, 1)
  const medHours = median(hoursArr)
  const medAcv = median(acvArr)

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM
  const xScale = (h: number) => PAD_LEFT + (h / maxHours) * plotW
  const yScale = (a: number) => PAD_TOP + plotH - (a / maxAcv) * plotH

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">{t('leader.opp_roi.description')}</p>
      <div className="relative rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-auto" role="img">
          {/* Over-investment quadrant background: x > medHours, y < medAcv */}
          <rect
            x={xScale(medHours)} y={yScale(medAcv)}
            width={xScale(maxHours) - xScale(medHours)} height={yScale(0) - yScale(medAcv)}
            fill="#fecaca" fillOpacity={0.35}
          />
          {/* Axes */}
          <line x1={PAD_LEFT} y1={PAD_TOP} x2={PAD_LEFT} y2={PAD_TOP + plotH} className="stroke-gray-300 dark:stroke-gray-700" strokeWidth={1} />
          <line x1={PAD_LEFT} y1={PAD_TOP + plotH} x2={PAD_LEFT + plotW} y2={PAD_TOP + plotH} className="stroke-gray-300 dark:stroke-gray-700" strokeWidth={1} />
          {/* Median guides */}
          <line x1={xScale(medHours)} y1={PAD_TOP} x2={xScale(medHours)} y2={PAD_TOP + plotH} stroke="#9ca3af" strokeDasharray="3 3" strokeWidth={1} />
          <line x1={PAD_LEFT} y1={yScale(medAcv)} x2={PAD_LEFT + plotW} y2={yScale(medAcv)} stroke="#9ca3af" strokeDasharray="3 3" strokeWidth={1} />
          {/* Axis labels */}
          <text x={PAD_LEFT + plotW / 2} y={HEIGHT - 8} textAnchor="middle" className="fill-gray-600 dark:fill-gray-400" fontSize={11}>{t('leader.opp_roi.hours_axis')}</text>
          <text x={16} y={PAD_TOP + plotH / 2} textAnchor="middle" className="fill-gray-600 dark:fill-gray-400" fontSize={11} transform={`rotate(-90 16 ${PAD_TOP + plotH / 2})`}>{t('leader.opp_roi.acv_axis')}</text>
          {/* Y-axis ticks (4) */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const v = f * maxAcv
            return (
              <g key={`y${f}`}>
                <line x1={PAD_LEFT - 3} y1={yScale(v)} x2={PAD_LEFT} y2={yScale(v)} className="stroke-gray-400" />
                <text x={PAD_LEFT - 6} y={yScale(v) + 3} textAnchor="end" className="fill-gray-500 dark:fill-gray-400" fontSize={10}>{fmtCurrency(v)}</text>
              </g>
            )
          })}
          {/* X-axis ticks (4) */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const v = f * maxHours
            return (
              <g key={`x${f}`}>
                <line x1={xScale(v)} y1={PAD_TOP + plotH} x2={xScale(v)} y2={PAD_TOP + plotH + 3} className="stroke-gray-400" />
                <text x={xScale(v)} y={PAD_TOP + plotH + 14} textAnchor="middle" className="fill-gray-500 dark:fill-gray-400" fontSize={10}>{v.toFixed(0)}</text>
              </g>
            )
          })}
          {/* Points */}
          {points.map((r) => {
            const h = Number(r.hours)
            const a = Number(r.acv ?? 0)
            const cx = xScale(h)
            const cy = yScale(a)
            const rad = 4 + Math.min(8, Math.log2(r.activityCount + 1) * 2)
            return (
              <circle
                key={r.oppId}
                cx={cx} cy={cy} r={rad}
                fill="#4f46e5" fillOpacity={0.75}
                stroke="#312e81" strokeWidth={1}
                onMouseEnter={() => setHover({ x: cx, y: cy, row: r })}
                onMouseLeave={() => setHover(null)}
                className="cursor-pointer"
              />
            )
          })}
        </svg>
        {hover && (
          <div
            className="pointer-events-none absolute rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-2 text-xs shadow"
            style={{
              left: `${(hover.x / WIDTH) * 100}%`,
              top: `${(hover.y / HEIGHT) * 100}%`,
              transform: 'translate(8px, 8px)',
            }}
          >
            <div className="font-semibold">{hover.row.oppName ?? '—'}</div>
            <div className="text-gray-600 dark:text-gray-400">{t('leader.opp_roi.tooltip_acv')}: {fmtCurrency(Number(hover.row.acv ?? 0))}</div>
            <div className="text-gray-600 dark:text-gray-400">{t('leader.opp_roi.tooltip_hours')}: {Number(hover.row.hours).toFixed(1)}</div>
            <div className="text-gray-600 dark:text-gray-400">{t('leader.opp_roi.tooltip_cost')}: {fmtCurrency(Number(hover.row.costDollars))}</div>
            <div className="text-gray-600 dark:text-gray-400">{t('leader.opp_roi.tooltip_activities')}: {hover.row.activityCount}</div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-400">
        <span className="inline-block h-3 w-3 rounded-sm bg-red-200" aria-hidden />
        <span>{t('leader.opp_roi.overinvest_legend')}</span>
      </div>
    </div>
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}
