import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { PlaneTakeoff, X, ArrowRight, ExternalLink, ZoomIn, ImageIcon, Info } from 'lucide-react'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { Button } from '../ui/button.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { getDateFnsLocale } from '../../lib/dateFnsLocale.js'
import { useBrandLogos } from '../../store/branding.js'
import { useTheme } from '../../store/theme.js'
import { setFlightDeckAvailable, useFlightDeckOpenRequest } from '../../store/flightDeck.js'

export interface FlightDeckItem {
  id: string
  label: string
  tooltip: string | null
  icon: string
  iconColor: string | null
  screenshots: string[]
  linkType: 'app_page' | 'external_url'
  linkValue: string
  sortOrder: number
  completed: boolean
}

interface FlightDeckData {
  items: FlightDeckItem[]
  showFlightDeck: boolean
  firstName: string | null
}

// Full-screen click-to-expand for a checklist item's screenshot thumbnails.
// Shared by the real modal and the admin Preview so both look identical.
function ScreenshotLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <img src={src} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-white/90 p-1.5 text-gray-700 hover:bg-white"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}

function ChecklistRow({
  item,
  index,
  onToggle,
  onOpen,
}: {
  item: FlightDeckItem
  index: number
  onToggle: (item: FlightDeckItem) => void
  onOpen: (item: FlightDeckItem) => void
}) {
  const { t } = useTranslation()
  const [lightbox, setLightbox] = useState<string | null>(null)
  // Details (tooltip text + screenshots, if any) start collapsed — the
  // expand button is what reveals them, so the list stays scannable. The
  // tooltip is still always available on hover via the row's `title` attr
  // below, regardless of expanded state.
  const [expanded, setExpanded] = useState(false)
  // Defensive: screenshots is typed as string[] but a row that predates this
  // column can still arrive as null from a not-yet-normalized response path
  // — guard rather than crash the modal on `.length`.
  const screenshots = item.screenshots ?? []
  const hasScreenshots = screenshots.length > 0
  const hasDetails = hasScreenshots || !!item.tooltip
  // The expand icon doubles as the "there's more here" affordance: a
  // picture icon when screenshots exist (they're the reason to expand),
  // otherwise a plain info icon so a tooltip-only item still gets an easy
  // way to read the full text instead of relying solely on hover.
  const ExpandIcon = hasScreenshots ? ImageIcon : Info
  const expandTitle = hasScreenshots
    ? t('settings.flight_deck.modal.view_screenshots', { count: screenshots.length })
    : t('settings.flight_deck.modal.view_details')
  const LinkIcon = item.linkType === 'external_url' ? ExternalLink : ArrowRight
  const linkTitle = t(
    item.linkType === 'external_url' ? 'settings.flight_deck.modal.open_link' : 'settings.flight_deck.modal.go_to_page',
  )

  return (
    <li className="flex flex-col gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex items-center gap-3">
        <span className="w-4 shrink-0 text-center text-xs font-semibold text-gray-400 dark:text-gray-500">
          {index + 1}
        </span>
        <input
          type="checkbox"
          checked={item.completed}
          onChange={() => onToggle(item)}
          className="h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 dark:border-gray-600"
          aria-label={t('settings.flight_deck.modal.mark_complete', { label: item.label })}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2" title={item.tooltip ?? undefined}>
          <DynamicIcon
            name={item.icon}
            className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400"
            style={item.iconColor ? { color: item.iconColor } : undefined}
          />
          <span
            className={cn(
              'truncate text-sm text-gray-900 dark:text-gray-100',
              item.completed && 'text-gray-400 line-through dark:text-gray-500',
            )}
          >
            {item.label}
          </span>
        </div>

        {/* The item's whole row used to be one big click target for
            navigation, which gave no visual hint that clicking did
            anything. The link button on the right is now the ONLY
            navigation trigger, with a hover tooltip explaining it. The
            expand button (picture icon when there are screenshots, info
            icon otherwise) is a second, separate affordance for reading
            the tooltip text / seeing attachments without navigating away —
            the tooltip itself is still always available on hover via the
            row's `title` attr above, expanded or not. */}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expandTitle}
            aria-label={expandTitle}
            aria-expanded={expanded}
            className={cn(
              'shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300',
              expanded && 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
            )}
          >
            <ExpandIcon className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpen(item)}
          title={linkTitle}
          aria-label={linkTitle}
          className="shrink-0 rounded p-1.5 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
        >
          <LinkIcon className="h-4 w-4" />
        </button>
      </div>

      {expanded && hasDetails && (
        <div className="ml-11 flex flex-col gap-2">
          {item.tooltip && <p className="text-xs text-gray-500 dark:text-gray-400">{item.tooltip}</p>}
          {hasScreenshots && (
            <div className="flex flex-wrap gap-1.5">
              {screenshots.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setLightbox(src)}
                  className="group relative h-12 w-16 shrink-0 overflow-hidden rounded border border-gray-200 dark:border-gray-700"
                >
                  <img src={src} alt="" className="h-full w-full object-cover" />
                  <span className="absolute inset-0 hidden items-center justify-center bg-black/40 group-hover:flex">
                    <ZoomIn className="h-4 w-4 text-white" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {lightbox && <ScreenshotLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </li>
  )
}

// Presentational modal chrome — shared by the real, data-fetching
// FlightDeckModal below and the admin Preview in FlightDeckConfig, so an
// admin previewing their in-progress checklist sees pixel-identical output
// to what a contributor will actually get.
export function FlightDeckModalView({
  firstName,
  items,
  dontShowAgain,
  onDontShowAgainChange,
  onToggleItem,
  onOpenItem,
  onDismiss,
  readOnly,
}: {
  firstName: string | null
  items: FlightDeckItem[]
  dontShowAgain: boolean
  onDontShowAgainChange: (next: boolean) => void
  onToggleItem: (item: FlightDeckItem) => void
  onOpenItem: (item: FlightDeckItem) => void
  onDismiss: () => void
  // Preview mode: no navigation, no persistence — just a visual stand-in.
  readOnly?: boolean
}) {
  const { t, i18n } = useTranslation()
  const today = format(new Date(), 'PPPP', { locale: getDateFnsLocale(i18n.language) })
  // Same team-theme logo the app's own PageHeader shows top-right on every
  // page (src/client/components/ui/page-header.tsx) — reusing that exact
  // light/dark selection logic keeps the modal visually consistent with the
  // rest of the app instead of introducing a second brand-logo convention.
  const { theme } = useTheme()
  const { logoLight, logoDark } = useBrandLogos()
  const headerLogo = theme === 'dark' ? (logoDark ?? logoLight) : (logoLight ?? logoDark)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={onDismiss} aria-hidden />
      <div
        className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        role="dialog"
        aria-modal
        aria-labelledby="flight-deck-title"
      >
        {/* No close (X) button by design — "Let's Get to Work" and the
            backdrop click are the only ways to dismiss. */}
        <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <PlaneTakeoff className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <h2 id="flight-deck-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('settings.flight_deck.modal.title', 'Flight Deck')}
            </h2>
          </div>
          {headerLogo && (
            <img
              src={headerLogo}
              alt=""
              className="h-[35px] w-[120px] shrink-0 object-contain object-right"
            />
          )}
        </div>

        <div className="px-6 pt-4">
          <p className="text-base font-medium text-gray-900 dark:text-gray-100">
            {firstName ? t('settings.flight_deck.modal.greeting_named', { name: firstName }) : t('settings.flight_deck.modal.greeting')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">{today}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.flight_deck.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {items.map((item, index) => (
                <ChecklistRow key={item.id} item={item} index={index} onToggle={onToggleItem} onOpen={onOpenItem} />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <img src="/logo-9-iq-spark-arcs.svg" alt="ImpactIQ" className="h-6 w-6 shrink-0" />
            <span className="text-sm font-bold text-blue-600 dark:text-blue-400">ImpactIQ</span>
          </div>
          <div className="flex items-center gap-3">
            {!readOnly && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={(e) => onDontShowAgainChange(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 dark:border-gray-600"
                />
                {t('settings.flight_deck.modal.dont_show_again')}
              </label>
            )}
            <Button onClick={onDismiss}>
              {t('settings.flight_deck.modal.cta')} <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Login welcome modal — a team-configurable onboarding checklist (Admin →
// Workplace → Flight Deck, see CLAUDE.md §14). Mounted once inside
// PageShell (App.tsx), which only ever renders for authenticated routes, so
// this needs no /setup or /login guard of its own.
//
// Fetches once per page load. Checking "Don't show again" persists via
// users.show_flight_deck (the same flag the My Settings toggle reads/
// writes) — so what actually suppresses the modal is the fetch on the NEXT
// login returning showFlightDeck:false. Closing without checking the box
// (X, backdrop click, or clicking through to an item) only hides it for
// this page load; it reappears next login, per spec.
export function FlightDeckModal() {
  const { i18n } = useTranslation()
  const navigate = useNavigate()
  const [data, setData] = useState<FlightDeckData | null>(null)
  const [closed, setClosed] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  // Header button (PageHeader, between the days-left pill and the language
  // picker) lives outside this component's tree — a monotonic counter in
  // the flightDeck store is how it tells us to reopen after the user has
  // already dismissed this page-load's auto-show.
  const openRequestId = useFlightDeckOpenRequest()

  useEffect(() => {
    let mounted = true
    api
      .get<FlightDeckData>(`/api/flight-deck?locale=${encodeURIComponent(i18n.language || 'en')}`)
      .then((res) => {
        if (mounted && res.data) setData(res.data)
      })
    return () => {
      mounted = false
    }
    // Fetch once per mount — the active locale at load time is enough; a
    // mid-session language change doesn't need to re-trigger the modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The header button only makes sense once we know the user actually has
  // it turned on and there's something to show — mirrors this component's
  // own render gate below, one level up via the shared store.
  useEffect(() => {
    setFlightDeckAvailable(!!data && data.showFlightDeck && data.items.length > 0)
  }, [data])

  // Skip the very first render's counter value (0) so mounting doesn't
  // itself count as an "open" request.
  const initialOpenRequestId = useState(openRequestId)[0]
  useEffect(() => {
    if (openRequestId !== initialOpenRequestId) setClosed(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequestId])

  if (!data || closed || !data.showFlightDeck || data.items.length === 0) return null

  async function toggleItem(item: FlightDeckItem) {
    const next = !item.completed
    setData((prev) => prev && { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, completed: next } : i)) })
    await api.patch(`/api/flight-deck/items/${item.id}/complete`, { completed: next })
  }

  // Checking off an item and navigating to it are separate actions —
  // completion is always the explicit checkbox click (CLAUDE.md decision:
  // manual only, no auto-detection).
  function openItem(item: FlightDeckItem) {
    if (item.linkType === 'external_url') {
      window.open(item.linkValue, '_blank', 'noopener,noreferrer')
      return
    }
    setClosed(true)
    navigate(item.linkValue)
  }

  async function handleDismiss() {
    if (dontShowAgain) {
      await api.patch('/api/flight-deck/preference', { show: false })
    }
    setClosed(true)
  }

  return (
    <FlightDeckModalView
      firstName={data.firstName}
      items={data.items}
      dontShowAgain={dontShowAgain}
      onDontShowAgainChange={setDontShowAgain}
      onToggleItem={(item) => void toggleItem(item)}
      onOpenItem={openItem}
      onDismiss={() => void handleDismiss()}
    />
  )
}
