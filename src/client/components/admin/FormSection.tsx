import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, ChevronRight, ChevronsDownUp, ChevronsUpDown, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { Label } from '../ui/label.js'

// v1.472.0: the colored, collapsible sections that group the User Management
// and Team Management edit forms. A closed section shows a one-line summary of
// its values so an admin can read a record without opening anything.

export type FormSectionColor = 'indigo' | 'violet' | 'sky' | 'teal' | 'emerald' | 'amber' | 'rose' | 'pink'

// Static class strings so Tailwind keeps them.
const COLOR_CLASSES: Record<FormSectionColor, { chip: string; open: string }> = {
  indigo: { chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300', open: 'border-indigo-300 dark:border-indigo-700' },
  violet: { chip: 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300', open: 'border-violet-300 dark:border-violet-700' },
  sky: { chip: 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300', open: 'border-sky-300 dark:border-sky-700' },
  teal: { chip: 'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300', open: 'border-teal-300 dark:border-teal-700' },
  emerald: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300', open: 'border-emerald-300 dark:border-emerald-700' },
  amber: { chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300', open: 'border-amber-300 dark:border-amber-700' },
  rose: { chip: 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300', open: 'border-rose-300 dark:border-rose-700' },
  pink: { chip: 'bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-300', open: 'border-pink-300 dark:border-pink-700' },
}

const STORAGE_PREFIX = 'impactiq.formSections.'

function readStored(storageKey: string): Record<string, boolean> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

function writeStored(storageKey: string, value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(value))
  } catch {
    // Storage blocked (private window, quota): the choice just isn't remembered.
  }
}

export interface FormSectionsState {
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
  setAll: (open: boolean) => void
}

/** Open/closed state for one form's sections, remembered per admin in this browser. */
export function useFormSections(storageKey: string, defaults: Record<string, boolean>): FormSectionsState {
  const [state, setState] = useState<Record<string, boolean>>(() => ({ ...defaults, ...(readStored(storageKey) ?? {}) }))
  const update = useCallback((next: Record<string, boolean>) => {
    setState(next)
    writeStored(storageKey, next)
  }, [storageKey])
  return {
    isOpen: (key) => state[key] ?? defaults[key] ?? false,
    toggle: (key) => update({ ...state, [key]: !(state[key] ?? defaults[key] ?? false) }),
    setAll: (open) => update(Object.fromEntries(Object.keys(defaults).map((k) => [k, open]))),
  }
}

export type FormSectionStatus =
  | { kind: 'done'; label: string }
  | { kind: 'missing'; label: string }
  | null

export function FormSection({
  id,
  icon: Icon,
  color,
  title,
  summary,
  status,
  open,
  onToggle,
  children,
}: {
  id: string
  icon: LucideIcon
  color: FormSectionColor
  title: string
  summary?: string
  status?: FormSectionStatus
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const c = COLOR_CLASSES[color]
  const bodyId = `form-section-${id}`
  return (
    <section className={cn('overflow-hidden rounded-lg border bg-white dark:bg-gray-900', open ? c.open : 'border-gray-200 dark:border-gray-700')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60"
      >
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', c.chip)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="shrink-0 text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</span>
        <span className={cn('min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400', open && 'invisible')}>{summary}</span>
        {status && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
              status.kind === 'done'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
            )}
          >
            {status.kind === 'done' ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
            {status.label}
          </span>
        )}
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform dark:text-gray-500', open && 'rotate-90')} />
      </button>
      {open && (
        <div id={bodyId} className="border-t border-dashed border-gray-200 px-3 pb-3 pt-3 sm:pl-[3.25rem] dark:border-gray-700">
          {children}
        </div>
      )}
    </section>
  )
}

/** Header row above a group of sections: form title, required legend, Expand all / Collapse all. */
export function FormSectionsToolbar({ title, state }: { title: string; state: FormSectionsState }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">{title}</p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          <span className="font-bold text-red-600 dark:text-red-400" aria-hidden="true">*</span> {t('admin.form_sections.required_legend')}
        </span>
        <button
          type="button"
          onClick={() => state.setAll(true)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ChevronsUpDown className="h-3 w-3" />{t('admin.form_sections.expand_all')}
        </button>
        <button
          type="button"
          onClick={() => state.setAll(false)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ChevronsDownUp className="h-3 w-3" />{t('admin.form_sections.collapse_all')}
        </button>
      </div>
    </div>
  )
}

/** A field label with a red asterisk when required, or a muted "optional" tag. */
export function FieldLabel({ children, required, optional, htmlFor }: { children: ReactNode; required?: boolean; optional?: boolean; htmlFor?: string }) {
  const { t } = useTranslation()
  return (
    <Label htmlFor={htmlFor} className="flex items-center gap-1">
      <span>{children}</span>
      {required && (
        <>
          <span className="font-bold text-red-600 dark:text-red-400" aria-hidden="true">*</span>
          <span className="sr-only">{t('admin.form_sections.required_sr')}</span>
        </>
      )}
      {optional && <span className="text-[10px] font-normal text-gray-400 dark:text-gray-500">{t('admin.form_sections.optional')}</span>}
    </Label>
  )
}

/** A small uppercase divider inside a section body (e.g. "Supported teams"). */
export function FormSubheading({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      <span>{children}</span>
      <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
    </p>
  )
}

/** Bottom bar: which required fields are still empty, then the form's buttons. */
export function FormSaveBar({ missing, children }: { missing: string[]; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
      {missing.length > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="h-3 w-3" />{t('admin.form_sections.missing', { fields: missing.join(', ') })}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-3 w-3" />{t('admin.form_sections.all_required_filled')}
        </span>
      )}
      <div className="flex gap-2">{children}</div>
    </div>
  )
}
