import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { pctChange, comparisonLabel, type CompareMode } from '../../lib/period.js'

function formatAbsDelta(delta: number): string {
  const abs = Math.abs(delta)
  if (abs >= 100) return abs.toFixed(0)
  if (abs >= 10) return abs.toFixed(1)
  return abs.toFixed(2)
}

interface Props {
  current: number
  prior: number
  mode: CompareMode
  className?: string
  invertColors?: boolean  // when up = bad (e.g. logging lag, sync failures)
}

// Small "+12% vs last month" chip. Neutral gray when direction is flat or
// baseline is zero (delta undefined).
export function TrendChip({ current, prior, mode, className, invertColors }: Props) {
  if (mode === 'off') return null
  const { pct, direction, hidden } = pctChange(current, prior)
  if (hidden) {
    return (
      <span className={cn('inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400', className)}>
        <Minus className="h-2.5 w-2.5" />
        <span className="tabular-nums">n/a</span>
        <span className="opacity-70">{comparisonLabel(mode)}</span>
      </span>
    )
  }
  const goodIsUp = !invertColors
  const isGood = direction === 'up' ? goodIsUp : direction === 'down' ? !goodIsUp : true
  const palette = direction === 'flat'
    ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
    : isGood
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
  const Icon = direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus
  const sign = pct > 0 ? '+' : ''
  return (
    <span
      title={`Current: ${current} · Prior: ${prior} · Δ ${sign}${pct}%`}
      className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium', palette, className)}
    >
      <Icon className="h-2.5 w-2.5" />
      <span className="tabular-nums">{sign}{pct}%</span>
      <span className="tabular-nums opacity-80">({current - prior >= 0 ? '+' : '−'}{formatAbsDelta(current - prior)})</span>
      <span className="opacity-70">{comparisonLabel(mode)}</span>
    </span>
  )
}
