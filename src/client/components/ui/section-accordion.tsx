import { useState, useEffect, type ReactNode, type ComponentType } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils.js'

interface Props {
  title: ReactNode
  count?: number
  icon?: ComponentType<{ className?: string }>
  defaultOpen?: boolean
  // Tighter styling for second-level (entity-name) accordions
  // nested inside a top-level group section.
  nested?: boolean
  // When these tick values change, the accordion resets to fully
  // open or fully closed. Lets a parent implement "Expand all" /
  // "Collapse all" without switching to controlled state per row.
  expandAllTick?: number
  collapseAllTick?: number
  children: ReactNode
  className?: string
}

// Small collapsible section. Wraps the app's existing
// details/summary pattern so callers don't reinvent the styling.
// State is local — pass `defaultOpen` for initial state; if a caller
// needs controlled open/close we can add that later.
export function SectionAccordion({ title, count, icon: Icon, defaultOpen = true, nested = false, expandAllTick, collapseAllTick, children, className }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  // Reset to open/closed when a parent bumps the corresponding tick.
  useEffect(() => { if (typeof expandAllTick === 'number' && expandAllTick > 0) setOpen(true) }, [expandAllTick])
  useEffect(() => { if (typeof collapseAllTick === 'number' && collapseAllTick > 0) setOpen(false) }, [collapseAllTick])
  return (
    <div className={cn(nested ? '' : 'border-b border-gray-100 dark:border-gray-800', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 text-left',
          nested
            ? 'px-4 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/60'
            : 'px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60',
        )}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        <span className="flex-1 truncate">{title}</span>
        {typeof count === 'number' && (
          <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500">{count}</span>
        )}
      </button>
      {open && <div className={nested ? '' : 'pb-1'}>{children}</div>}
    </div>
  )
}
