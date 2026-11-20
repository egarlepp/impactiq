import React, { useState, useRef, useEffect, useLayoutEffect, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import * as LucideIcons from 'lucide-react'
import { Smile } from 'lucide-react'
import { Input } from './input.js'
import { cn } from '../../lib/utils.js'

// Curated shortlist shown by default before the admin types a search query —
// browsing all ~4,000 real icons (below) at once isn't useful, but searching
// across all of them is. Names that do not exist in the installed
// lucide-react build have been removed (Lightning, Fire, Tool, Tree).
export const ICON_NAMES: string[] = [
  'Users', 'Building2', 'Building', 'Briefcase', 'Globe', 'Globe2', 'Cpu', 'Zap', 'Shield', 'ShieldCheck',
  'Star', 'Sparkles', 'Rocket', 'Target', 'Crosshair', 'Award', 'Trophy', 'Medal',
  'Layers', 'Grid', 'LayoutGrid', 'LayoutDashboard', 'MonitorDot', 'Monitor',
  'Code', 'Code2', 'Terminal', 'Database', 'Server', 'Cloud', 'CloudLightning',
  'Activity', 'BarChart', 'BarChart2', 'BarChart3', 'LineChart', 'PieChart', 'TrendingUp', 'TrendingDown',
  'Bolt', 'Flame', 'Flashlight',
  'Handshake', 'HeartHandshake', 'Heart', 'ThumbsUp',
  'Lightbulb', 'Brain', 'Microscope', 'FlaskConical', 'Atom',
  'Map', 'MapPin', 'Compass', 'Navigation', 'Route',
  'Coins', 'DollarSign', 'Wallet', 'CreditCard', 'Banknote',
  'Phone', 'Smartphone', 'Mail', 'MessageSquare', 'MessageCircle',
  'Calendar', 'Clock', 'Timer', 'AlarmClock',
  'Lock', 'Unlock', 'Key', 'Fingerprint',
  'Settings', 'Settings2', 'SlidersHorizontal', 'Wrench',
  'Leaf', 'Sprout', 'Sun', 'Moon', 'Snowflake', 'Wind',
  'Truck', 'Car', 'Plane', 'Ship', 'Package', 'Box',
]

// v1.250.0: every real lucide-react icon component, computed once at module
// load, so every consumer of this file (nudge rules, activity types, teams,
// templates, Flight Deck, …) gets the full library instead of the ~90-name
// shortlist above. lucide-react exports two names per icon (e.g.
// "AlertCircle" and the identical "AlertCircleIcon" alias) plus a handful of
// non-icon utility exports (createLucideIcon, icons, LucideProvider,
// useLucideContext) — filtering out the "*Icon"-suffixed aliases and
// anything that isn't a component leaves exactly one canonical name per icon.
export const ALL_ICON_NAMES: string[] = Object.keys(LucideIcons)
  .filter((name) => {
    if (name.endsWith('Icon')) return false
    const value = (LucideIcons as unknown as Record<string, unknown>)[name]
    return typeof value === 'object' && value !== null && '$$typeof' in (value as object)
  })
  .sort((a, b) => a.localeCompare(b))

type IconComponent = ComponentType<{ className?: string; style?: React.CSSProperties }>

export function getIconComponent(name: string | null | undefined): IconComponent | null {
  if (!name) return null
  const icon = (LucideIcons as Record<string, unknown>)[name] as IconComponent | undefined
  return icon ?? null
}

export function DynamicIcon({ name, className, style }: { name: string | null | undefined; className?: string; style?: React.CSSProperties }) {
  const Icon = getIconComponent(name)
  if (!Icon) return null
  return <Icon className={className} style={style} />
}

const POPOVER_WIDTH = 288 // w-72
const SEARCH_RESULT_CAP = 300 // full-library search can match hundreds; cap the DOM node count

export function IconPicker({
  value,
  onChange,
}: {
  value: string | null | undefined
  onChange: (icon: string | null) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // v1.250.0: rendered via a document.body portal with fixed positioning
  // (same technique as SingleSelect/MultiSelect) instead of a plain
  // `absolute` child — the old approach let the 288px-wide popover overflow
  // a narrow parent column and grow the WHOLE page's scrollWidth, which
  // showed up as the entire admin content area shifting/scrolling sideways
  // the moment this opened inside FlightDeckConfig's two-column item form.
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const b = btnRef.current.getBoundingClientRect()
    const left = Math.min(b.left, window.innerWidth - POPOVER_WIDTH - 8)
    const top = Math.min(b.bottom + 4, window.innerHeight - 260)
    setRect({ top: Math.max(top, 8), left: Math.max(left, 8) })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (popRef.current?.contains(target)) return
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

  const Current = getIconComponent(value)
  const q = query.trim().toLowerCase()
  // Empty query → curated shortlist (fast to scan). Non-empty query →
  // search the full ~4,000-icon library, capped to keep the grid responsive.
  const filtered = q
    ? ALL_ICON_NAMES.filter((n) => n.toLowerCase().includes(q)).slice(0, SEARCH_RESULT_CAP)
    : ICON_NAMES

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        {Current ? <Current className="h-4 w-4" /> : <Smile className="h-4 w-4 text-gray-400" />}
        <span>{value ?? t('admin.icon_picker.pick')}</span>
      </button>

      {open && rect && createPortal(
        <div
          ref={popRef}
          className="fixed z-[100] w-72 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ top: rect.top, left: rect.left }}
        >
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('admin.icon_picker.search')}
            className="mb-2 h-8 text-xs"
          />
          <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto">
            {filtered.map((name) => {
              const Icon = getIconComponent(name)
              if (!Icon) return null
              const selected = name === value
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => {
                    onChange(selected ? null : name)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex flex-col items-center gap-0.5 rounded-md p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
                    selected && 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="w-full truncate text-center text-[10px]">{name}</span>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <p className="col-span-6 py-4 text-center text-xs text-gray-400 dark:text-gray-500">
                {t('admin.icon_picker.no_results')}
              </p>
            )}
          </div>
          {!q && (
            <p className="mt-1 text-center text-[10px] text-gray-400 dark:text-gray-500">
              {t('admin.icon_picker.search_hint')}
            </p>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
