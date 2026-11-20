import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'

// A settings card whose body expands and collapses from its header (Admin →
// Integrations groups). The header stays useful while collapsed: `badges`
// carries the card's state (Active / Inactive, Locked / Unlocked, ...).
export function CollapsibleCard({
  icon: Icon,
  title,
  description,
  badges,
  defaultOpen = false,
  children,
}: {
  icon: LucideIcon
  title: string
  description: string
  badges?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-3 p-5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? t('admin.integrations.card_collapse') : t('admin.integrations.card_expand')}
          className="-m-1 flex min-w-0 flex-1 items-start gap-3 rounded-md p-1 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60"
        >
          <Chevron className="mt-2 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
          <div className="rounded-md bg-gray-100 p-2 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-gray-900 dark:text-gray-100">{title}</p>
            <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{description}</p>
          </div>
        </button>
        {badges && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{badges}</div>}
      </div>
      {open && <div className="flex flex-col gap-4 border-t border-gray-200 p-5 dark:border-gray-700">{children}</div>}
    </div>
  )
}
