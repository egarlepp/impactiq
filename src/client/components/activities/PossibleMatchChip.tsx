import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Building2, Target, ChevronDown, RefreshCw, Search } from 'lucide-react'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.91.0: inline "possible match" chip on suggested-activity cards.
// Renders as `[icon] Account/Opportunity: <name> ▾`. Click opens a compact
// popover of top candidates (from the cached SOQL result on the server) +
// a Refresh icon that re-runs the SF match for just this event, and a
// "Search more…" entry that hands off to the parent's onSearchMore
// callback (which typically opens the existing SfSearch modal).

export interface Candidate { id: string; name: string; type: 'Account' | 'Opportunity'; detail?: string | null }

interface Props {
  kind: 'Account' | 'Opportunity'
  eventId: string
  current: { id: string; name: string } | null
  candidates: Candidate[] | null
  onPick: (pick: { id: string; name: string; type: 'Account' | 'Opportunity' } | null) => void
  // v1.100.0: separate callback for the Clear entry so the parent can
  // hide the auto-suggestion for just this chip's kind without wiping
  // the other chip's state.
  onClear?: () => void
  onRecomputed: (payload: { suggestedAccount: { id: string; name: string } | null; suggestedOpportunity: { id: string; name: string } | null; suggestionCandidates: Candidate[] | null }) => void
  onSearchMore: () => void
}

export function PossibleMatchChip({ kind, eventId, current, candidates, onPick, onClear, onRecomputed, onSearchMore }: Props) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  // Rendered into document.body via a portal with position:fixed so it
  // escapes the card's own overflow/stacking context — otherwise a chip on
  // a card near the bottom of the scrollable activity list gets its
  // popover clipped by the card below it (same fix as SingleSelect/
  // MultiSelect/SubteamFilter/SubtypeFilter).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const b = btnRef.current.getBoundingClientRect()
    setRect({ top: b.bottom + 4, left: b.left })
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

  async function recompute() {
    setRefreshing(true)
    try {
      const res = await api.post<{ suggestedAccount: { id: string; name: string } | null; suggestedOpportunity: { id: string; name: string } | null; suggestionCandidates: Candidate[] | null }>(`/api/outlook/suggestions/${encodeURIComponent(eventId)}/recompute`, {})
      if (res.data) onRecomputed(res.data)
    } finally {
      setRefreshing(false)
    }
  }

  const Icon = kind === 'Account' ? Building2 : Target
  // Deal / Company on HubSpot, Opportunity / Account otherwise.
  const kindLabel = kind === 'Account' ? t('sf.account', { context: crmCtx }) : t('sf.opportunity', { context: crmCtx })
  // Filter candidates to this chip's kind and skip the currently selected id.
  const rows = (candidates ?? []).filter((c) => c.type === kind)
  const label = current
    ? `${kindLabel}: ${current.name}`
    : t('activity.match.pick_kind', { kind: kindLabel })

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
          current
            ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-dashed border-gray-300 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400',
        )}
        title={label}
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="max-w-[180px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </button>
      {open && rect && createPortal(
        <div
          ref={popRef}
          className="fixed z-[100] min-w-[240px] rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ top: rect.top, left: rect.left }}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
            <span>{t('activity.match.possible_kind', { kind: kindLabel })}</span>
            <button
              type="button"
              onClick={() => void recompute()}
              className="rounded p-0.5 text-gray-400 hover:text-blue-600"
              title={t('activity.match.recompute')}
              disabled={refreshing}
            >
              {refreshing ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
            </button>
          </div>
          <ul className="max-h-56 overflow-y-auto py-1 text-sm">
            {rows.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('activity.match.none')}</li>
            )}
            {rows.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => { setOpen(false); onPick({ id: c.id, name: c.name, type: c.type }) }}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800',
                    current?.id === c.id && 'bg-blue-50 dark:bg-blue-950/40',
                  )}
                >
                  <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.name}</span>
                    {c.detail && <span className="block truncate text-[11px] text-gray-500 dark:text-gray-400">{c.detail}</span>}
                  </span>
                </button>
              </li>
            ))}
            {current && (
              <li>
                <button
                  type="button"
                  onClick={() => { setOpen(false); if (onClear) onClear(); else onPick(null) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  {t('activity.match.clear')}
                </button>
              </li>
            )}
            <li className="border-t border-gray-100 dark:border-gray-800">
              <button
                type="button"
                onClick={() => { setOpen(false); onSearchMore() }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
              >
                <Search className="h-3.5 w-3.5" />
                {t('activity.match.search_more')}
              </button>
            </li>
          </ul>
        </div>,
        document.body,
      )}
    </div>
  )
}
