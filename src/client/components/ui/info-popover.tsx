import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

// v1.226.0: generic "info button → portal-rendered explainer popover"
// component, extracted from the anomalies panel's original bespoke
// implementation (AnomalyHelp) so every panel that needs a small "what does
// this mean / why don't I see it" explainer can share one implementation
// instead of re-copying the positioning logic.
//
// Unlike the app's other popovers, this one can be long enough to need its
// own scrollbar, so it can't use the usual close-on-scroll behaviour: it
// FOLLOWS the trigger on scroll instead of dismissing, and explicitly ignores
// scroll events that originate inside its own scroll container (otherwise
// reading past the fold would dismiss the thing being read).

export function InfoPopover({
  ariaLabel,
  widthPx = 380,
  children,
}: {
  ariaLabel: string
  widthPx?: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Extracted so the scroll handler can re-run it.
  const place = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const MARGIN = 8
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - widthPx - MARGIN))
    setPos({ top: r.bottom + 4, left })
  }, [widthPx])

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const n = e.target as Node
      if (btnRef.current?.contains(n)) return
      if (popRef.current?.contains(n)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    function onScroll(e: Event) {
      // Scrolling the explainer's OWN content fires a scroll event that the
      // capture-phase listener sees. Closing on any scroll would dismiss the
      // popover the moment someone reads past the fold. Ignore our own
      // scroll container entirely; everything else re-follows the trigger.
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return
      place()
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, place])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        title={ariaLabel}
        aria-label={ariaLabel}
        className="inline-flex shrink-0 items-center rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: widthPx }}
          className="z-[100] max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 text-xs normal-case tracking-normal shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  )
}
