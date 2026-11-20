import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import i18n, { SUPPORTED_LANGUAGES } from '../../i18n/index.js'

// Compact language picker used in the login screen header and the top nav.
// Hover reveals the currently-selected language via `title`; click opens a
// list of options. Selection persists to localStorage via the same key the
// Settings page uses, so it survives a full sign-out.
export function LanguagePicker({ variant = 'light' }: { variant?: 'light' | 'dark' }) {
  const { i18n: i18nHook } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const currentCode = (i18nHook.resolvedLanguage ?? i18nHook.language ?? 'en').slice(0, 2)
  const current = SUPPORTED_LANGUAGES.find((l) => l.code === currentCode) ?? SUPPORTED_LANGUAGES[0]

  function pick(code: string) {
    void i18n.changeLanguage(code)
    try { localStorage.setItem('impactiq_language', code) } catch { /* ignore */ }
    setOpen(false)
  }

  const buttonCls = variant === 'light'
    ? 'flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20'
    : 'flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100'

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} title={current?.label ?? 'Language'} className={buttonCls}>
        <Globe className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 min-w-[160px] rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <ul className="py-1 text-sm">
            {SUPPORTED_LANGUAGES.map((l) => (
              <li key={l.code}>
                <button
                  type="button"
                  onClick={() => pick(l.code)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800 ${l.code === currentCode ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200'}`}
                >
                  <span>{l.label}</span>
                  <span className="text-[10px] uppercase text-gray-400">{l.code}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
