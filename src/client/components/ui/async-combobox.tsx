import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, X, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils.js'

export interface AsyncOption {
  id: string
  label: string
  subLabel?: string
}

interface Props {
  value: AsyncOption[]
  onChange: (next: AsyncOption[]) => void
  fetchOptions: (q: string) => Promise<AsyncOption[]>
  placeholder?: string
  emptyHint?: string
  className?: string
}

// Debounced async multi-select combobox. Renders selected items as inline
// chips with an X to remove; typing in the search input triggers
// fetchOptions after 250ms of idle. The dropdown is portalled with fixed
// positioning so it escapes ancestor overflow.
export function AsyncCombobox({ value, onChange, fetchOptions, placeholder, emptyHint, className }: Props) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [options, setOptions] = useState<AsyncOption[]>([])
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(h)
  }, [query])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void fetchOptions(debounced).then((opts) => {
      if (cancelled) return
      // Exclude already-selected ids.
      const chosen = new Set(value.map((v) => v.id))
      setOptions(opts.filter((o) => !chosen.has(o.id)))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [debounced, open, value])

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return
    const b = rootRef.current.getBoundingClientRect()
    setRect({ top: b.bottom + 4, left: b.left, width: b.width })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (rootRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function add(o: AsyncOption) {
    if (value.some((v) => v.id === o.id)) return
    onChange([...value, o])
    setQuery('')
    inputRef.current?.focus()
  }
  function remove(id: string) {
    onChange(value.filter((v) => v.id !== id))
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div
        onClick={() => { setOpen(true); inputRef.current?.focus() }}
        className="flex min-h-[2.25rem] flex-wrap items-center gap-1 rounded-md border border-gray-300 bg-white px-1.5 py-1 dark:border-gray-600 dark:bg-gray-800"
      >
        {value.map((v) => (
          <span
            key={v.id}
            className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
          >
            {v.label}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); remove(v.id) }}
              className="text-blue-500 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-100"
              aria-label="remove"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={value.length === 0 ? placeholder ?? '' : ''}
          className="flex-1 min-w-[6rem] border-0 bg-transparent px-1 py-0.5 text-sm text-gray-800 outline-none dark:text-gray-100"
        />
        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
      </div>
      {open && rect && createPortal(
        <div
          ref={popRef}
          className="fixed z-[100] rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800"
          style={{ top: rect.top, left: rect.left, width: rect.width }}
        >
          <div className="max-h-72 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" /> …
              </div>
            ) : options.length === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                {emptyHint ?? '—'}
              </p>
            ) : (
              options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => add(o)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <span className="text-gray-800 dark:text-gray-100">{o.label}</span>
                  {o.subLabel && (
                    <span className="text-[10px] text-gray-400">{o.subLabel}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
