import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils.js'

interface Option {
  value: string
  label: string
  hint?: string
  group?: string
  // Optional leading icon rendered in the dropdown row (not in the
  // trigger chip — callers who need an icon on the chip too can render
  // one themselves next to the SingleSelect).
  icon?: ComponentType<{ className?: string }>
  // Optional secondary line rendered under the label in the dropdown,
  // explaining what the choice does.
  description?: string
}

interface Props {
  label: string
  // v1.134.0: optional leading icon on the trigger chip (e.g. a
  // Users icon next to "Team member:"). Renders left of the label.
  labelIcon?: ComponentType<{ className?: string }>
  options: Option[]
  value: string
  onChange: (next: string) => void
  placeholder?: string
  className?: string
}

// Compact single-select chip. The dropdown is rendered into document.body via
// a portal with position:fixed so it escapes any ancestor overflow / stacking
// context — otherwise the sidebar or a scrolling parent clips the list.
export function SingleSelect({ label, labelIcon: LabelIcon, options, value, onChange, placeholder, className }: Props) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ top: number; right: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const b = btnRef.current.getBoundingClientRect()
    setRect({ top: b.bottom + 4, right: window.innerWidth - b.right })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    function onScroll(e: Event) {
      // Ignore scrolls that happen inside the popover itself — the user is
      // scrolling the option list. Only close for outside scroll containers.
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onResize() { setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const current = options.find((o) => o.value === value)
  const summary = current?.label ?? placeholder ?? 'Select'

  const grouped = options.some((o) => o.group)
  const groups = grouped
    ? Array.from(new Set(options.map((o) => o.group ?? ''))).map((g) => ({
        name: g,
        items: options.filter((o) => (o.group ?? '') === g),
      }))
    : [{ name: '', items: options }]

  return (
    <div className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        {LabelIcon && <LabelIcon className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />}
        <span className="text-gray-500 dark:text-gray-400">{label}:</span>
        <span className="max-w-[12rem] truncate">{summary}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && rect && createPortal(
        <div
          ref={popRef}
          className="fixed z-[100] w-64 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800"
          style={{ top: rect.top, right: rect.right }}
        >
          <div className="max-h-[min(24rem,calc(100vh-6rem))] overflow-y-auto">
            {options.length === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">No options.</p>
            ) : (
              groups.map((g) => (
                <div key={g.name || 'default'}>
                  {g.name && (
                    <div className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{g.name}</div>
                  )}
                  {g.items.map((o) => {
                    const Icon = o.icon
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => { onChange(o.value); setOpen(false) }}
                        className={cn(
                          'flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700',
                          o.value === value
                            ? 'font-semibold text-blue-600 dark:text-blue-400'
                            : 'text-gray-700 dark:text-gray-200',
                        )}
                      >
                        {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                        <span className="flex-1">
                          <span className="flex items-center gap-2">
                            <span className="flex-1 truncate">{o.label}</span>
                            {o.hint && <span className="text-[10px] text-gray-400">{o.hint}</span>}
                          </span>
                          {o.description && (
                            <span className="mt-0.5 block text-[10px] font-normal leading-snug text-gray-400 dark:text-gray-500">{o.description}</span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
