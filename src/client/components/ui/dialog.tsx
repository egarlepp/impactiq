import { type ReactNode, type ComponentType, useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { Button } from './button.js'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  titleIcon?: ComponentType<{ className?: string }>
  // Optional slot rendered before the X close button in the title bar.
  // Used for destructive actions (e.g. delete) that need to sit at the
  // top-right of the drawer.
  headerActions?: ReactNode
  children: ReactNode
  className?: string
}

export function Dialog({ open, onClose, title, titleIcon: TitleIcon, headerActions, children, className }: DialogProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={cn(
          'relative z-10 flex h-full w-full max-w-xl flex-col bg-white shadow-xl dark:bg-gray-900 overflow-y-auto',
          className,
        )}
        role="dialog"
        aria-modal
        aria-labelledby="dialog-title"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <h2 id="dialog-title" className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {TitleIcon && <TitleIcon className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />}
            {title}
          </h2>
          <div className="flex items-center gap-1">
            {headerActions}
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex-1 p-6">{children}</div>
      </div>
    </div>
  )
}
