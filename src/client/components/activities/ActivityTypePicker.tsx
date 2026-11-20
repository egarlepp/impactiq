import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { type ActivityType } from '../../hooks/useTeam.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { cn } from '../../lib/utils.js'

// v1.416.0: the Activity Type dropdown, moved unchanged out of ActivityForm.tsx.

export function ActivityTypePicker({
  id,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string
  value: string
  options: ActivityType[]
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.id === value) ?? null
  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={cn(
          'flex w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-left dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <span className="flex items-center gap-2">
          {selected?.icon && (
            <DynamicIcon
              name={selected.icon}
              className="h-4 w-4"
              {...(selected.color ? { style: { color: selected.color } } : {})}
            />
          )}
          {!selected?.icon && selected?.color && (
            <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: selected.color }} />
          )}
          <span>{selected?.name ?? ''}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-gray-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => { onChange(o.id); setOpen(false) }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700',
                o.id === value && 'font-semibold',
              )}
            >
              {o.icon && (
                <DynamicIcon name={o.icon} className="h-4 w-4" {...(o.color ? { style: { color: o.color } } : {})} />
              )}
              {!o.icon && o.color && (
                <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: o.color }} />
              )}
              <span>{o.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
