import { useRef, useState, useEffect, useLayoutEffect, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Minus, X } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { DynamicIcon } from './icon-picker.js'

interface Option {
  value: string
  label: string
  hint?: string
  // v1.134.0: optional per-option leading icon (lucide component)
  // and/or an image URL/data-uri (product icons come in as data
  // URIs). If both provided, iconUrl wins for the leading slot.
  icon?: ComponentType<{ className?: string }>
  iconUrl?: string
  // v1.196.0: optional collapsible group. Options without a group render
  // flat at the top; options sharing a group are tucked under a clickable,
  // collapsed-by-default header (e.g. "Legacy Stages").
  group?: string
  // v1.270.0: optional icon (by admin-configurable DynamicIcon name, e.g.
  // an Activity Type's own icon) + color shown on the GROUP header itself,
  // not the option row — set on every option sharing a group since the
  // header only reads it off the first one. Lets a grouped picker (e.g.
  // SubtypeFilter) show which Activity Type each group belongs to using
  // that exact same icon/color, not just the group's name.
  groupIconName?: string
  groupIconColor?: string
}

interface Props {
  label: string
  // Optional leading icon on the trigger chip (for the label itself,
  // e.g. `Users` icon next to "Team member:").
  labelIcon?: ComponentType<{ className?: string }>
  options: Option[]
  selected: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
}

// Compact multi-select for dashboard header filters. Renders as a chip
// summarising the selection ("Products: All" or "Products: A, B, +2") and
// opens a checkbox list below, rendered into document.body via a portal with
// position:fixed so it escapes any ancestor overflow/stacking context —
// otherwise the sidebar or a scrolling parent clips it (see SingleSelect).
export function MultiSelect({ label, labelIcon: LabelIcon, options, selected, onChange, placeholder, className }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
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

  function toggle(value: string) {
    const has = selected.includes(value)
    onChange(has ? selected.filter((v) => v !== value) : [...selected, value])
  }

  // v1.276.0: select/deselect every option in a group at once from the
  // group header's own checkbox — previously the header only toggled
  // collapse/expand, so checking off e.g. all 5 Demo subtypes meant
  // clicking each one individually.
  function toggleGroup(items: Option[]) {
    const values = items.map((o) => o.value)
    const allSelected = values.every((v) => selected.includes(v))
    if (allSelected) {
      const drop = new Set(values)
      onChange(selected.filter((v) => !drop.has(v)))
    } else {
      onChange(Array.from(new Set([...selected, ...values])))
    }
  }

  const ungrouped = options.filter((o) => !o.group)
  const grouped = new Map<string, Option[]>()
  for (const o of options) {
    if (!o.group) continue
    if (!grouped.has(o.group)) grouped.set(o.group, [])
    grouped.get(o.group)!.push(o)
  }
  const groupNames = Array.from(grouped.keys())

  function renderOption(o: Option) {
    const on = selected.includes(o.value)
    const OptIcon = o.icon
    return (
      <button
        key={o.value}
        type="button"
        onClick={() => toggle(o.value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        <span className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
          on ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 dark:border-gray-500',
        )}>
          {on && <Check className="h-2.5 w-2.5" />}
        </span>
        {o.iconUrl ? (
          <img src={o.iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm object-contain" />
        ) : OptIcon ? (
          <OptIcon className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
        ) : null}
        <span className="flex-1 truncate text-gray-700 dark:text-gray-200">{o.label}</span>
        {o.hint && <span className="text-[10px] text-gray-400">{o.hint}</span>}
      </button>
    )
  }

  const selectedOpts = options.filter((o) => selected.includes(o.value))
  const summary =
    selected.length === 0
      ? (placeholder ?? 'All')
      : selectedOpts.length <= 2
      ? selectedOpts.map((o) => o.label).join(', ')
      : `${selectedOpts.slice(0, 2).map((o) => o.label).join(', ')}, +${selectedOpts.length - 2}`

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
        <span className="max-w-[10rem] truncate">{summary}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && rect && createPortal(
        <div
          ref={popRef}
          className="fixed z-[100] w-64 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800"
          style={{ top: rect.top, right: rect.right }}
        >
          <div className="flex items-center justify-between px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <span>{label}</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400">
                <X className="h-2.5 w-2.5" /> {t('common.clear', 'Clear')}
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {options.length === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('common.no_options', 'No options.')}</p>
            ) : (
              <>
                {ungrouped.map((o) => renderOption(o))}
                {groupNames.map((gname) => {
                  const items = grouped.get(gname)!
                  // Auto-expand a group the user has a selection inside, so a
                  // chosen legacy value stays visible.
                  const selCount = items.filter((o) => selected.includes(o.value)).length
                  const hasSel = selCount > 0
                  const allSel = selCount === items.length
                  const isOpen = expandedGroups.has(gname) || hasSel
                  return (
                    <div key={gname} className="border-t border-gray-100 dark:border-gray-700">
                      <div className="flex w-full items-center gap-1 py-1.5 pl-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        <button
                          type="button"
                          onClick={() => toggleGroup(items)}
                          title={allSel ? t('common.deselect_all', 'Deselect all {{group}}', { group: gname }) : t('common.select_all', 'Select all {{group}}', { group: gname })}
                          aria-label={allSel ? t('common.deselect_all', 'Deselect all {{group}}', { group: gname }) : t('common.select_all', 'Select all {{group}}', { group: gname })}
                          className={cn(
                            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                            allSel || hasSel ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 dark:border-gray-500',
                          )}
                        >
                          {allSel ? <Check className="h-2.5 w-2.5" /> : hasSel ? <Minus className="h-2.5 w-2.5" /> : null}
                        </button>
                        <button
                          type="button"
                          onClick={() => setExpandedGroups((prev) => {
                            const next = new Set(prev)
                            if (next.has(gname)) next.delete(gname); else next.add(gname)
                            return next
                          })}
                          className="flex flex-1 items-center gap-1 rounded text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        >
                          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          {items[0]?.groupIconName && (
                            <DynamicIcon name={items[0].groupIconName} className="h-3 w-3 shrink-0" style={{ color: items[0].groupIconColor ?? undefined }} />
                          )}
                          <span className="flex-1">{gname}</span>
                          <span className="text-gray-400">{items.length}</span>
                        </button>
                      </div>
                      {isOpen && items.map((o) => renderOption(o))}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
