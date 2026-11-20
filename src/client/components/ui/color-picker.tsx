import { useState, useEffect, useRef, memo } from 'react'
import { HexColorPicker } from 'react-colorful'
import { X, Pipette } from 'lucide-react'
import { Label } from './label.js'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

// The standalone browser EyeDropper API (Chrome/Edge only, feature-detected
// below) — NOT the same thing as native <input type="color">'s built-in
// eyedropper, which is what actually froze users' browsers (see this file's
// own history above). This API just samples one pixel color from the screen
// and returns it; it doesn't open the OS-level color-chooser dialog that
// caused the freeze, so it's safe to offer here as an extra button rather
// than reintroducing the native input.
interface EyeDropperResult { sRGBHex: string }
interface EyeDropperCtor { new (): { open: () => Promise<EyeDropperResult> } }
function getEyeDropperCtor(): EyeDropperCtor | null {
  return typeof window !== 'undefined' && 'EyeDropper' in window
    ? (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper
    : null
}

function cnHex(invalid: boolean): string {
  const base = 'h-8 w-24 rounded border px-2 font-mono text-[11px] uppercase text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-900 focus:outline-none focus:ring-1'
  return invalid
    ? `${base} border-red-500 ring-red-500 dark:border-red-400`
    : `${base} border-gray-300 dark:border-gray-600 focus:ring-blue-500`
}

// Swatch button + eyedropper button + hex text input + a react-colorful
// popover — the app's one color-picker pattern, generalized out of
// ThemingConfig.tsx's original (there-private) ColorField so every feature
// that needs a hex color can share it instead of reaching for a native
// <input type="color">. That native picker was tried first for theme colors
// and removed after it froze users' browsers via its built-in OS-level
// eyedropper, regardless of how aggressively the app debounced it (v1.35.2
// attempted that; still froze) — see ThemingConfig.tsx's own history for the
// full writeup. v1.361.0 added the Pipette button above using the standalone
// `window.EyeDropper` API instead — a different mechanism (samples one pixel
// from the screen, no OS color-chooser dialog involved), so it restores the
// dropper workflow without reintroducing the thing that actually froze.
// Chrome/Edge only; the button simply doesn't render on browsers without it
// (Safari/Firefox), same graceful-degrade as any other feature-detected API
// in this app. As of v1.361.0 this is used by every color field in the app —
// Activity Types and Flight Deck's own native <input type="color"> icon-color
// fields were converted to this component in the same pass.
export const ColorPicker = memo(function ColorPicker({
  label,
  value,
  onChange,
  onReset,
}: {
  label: string
  // null = unset — renders an empty/dashed swatch and a blank hex input
  // rather than assuming some default.
  value: string | null
  onChange: (next: string) => void
  // Present only when the field is meant to be resettable back to null
  // (e.g. "use the default severity color instead") — renders a small X
  // button next to the input, same convention FlightDeckConfig's iconColor
  // reset already uses. Omit for a field that's always required (e.g.
  // theme colors, which are never null).
  onReset?: () => void
}) {
  const [draft, setDraft] = useState(value ?? '')
  const [invalid, setInvalid] = useState(false)
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)
  const EyeDropperCtor = getEyeDropperCtor()

  async function pickFromScreen() {
    if (!EyeDropperCtor) return
    try {
      const result = await new EyeDropperCtor().open()
      setDraft(result.sRGBHex)
      setInvalid(false)
      onChange(result.sRGBHex)
    } catch {
      // User pressed Escape / cancelled the pick — nothing to do.
    }
  }

  // Sync when the parent value changes externally (e.g. Reset, a preset applied).
  useEffect(() => { setDraft(value ?? ''); setInvalid(false) }, [value])

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  function commit(next: string) {
    const trimmed = next.trim()
    if (trimmed === '') return
    const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
    if (HEX_RE.test(candidate)) {
      setInvalid(false)
      setDraft(candidate)
      onChange(candidate)
    } else {
      setInvalid(true)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <div className="relative flex items-center gap-1.5" ref={popRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={value ?? undefined}
          aria-label={`${label} — open picker`}
          className="h-8 w-8 shrink-0 cursor-pointer rounded border border-gray-300 hover:ring-2 hover:ring-blue-400 dark:border-gray-600 dark:hover:ring-blue-500"
          style={{ backgroundColor: value ?? 'transparent', borderStyle: value ? 'solid' : 'dashed' }}
        />
        {EyeDropperCtor && (
          <button
            type="button"
            onClick={() => { void pickFromScreen() }}
            title={`${label} — pick from screen`}
            aria-label={`${label} — pick from screen`}
            className="h-8 w-8 shrink-0 cursor-pointer rounded border border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <Pipette className="mx-auto h-4 w-4" />
          </button>
        )}
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            const v = e.target.value.trim()
            if (v === '') { setInvalid(false); return }
            const candidate = v.startsWith('#') ? v : `#${v}`
            if (HEX_RE.test(candidate)) {
              setInvalid(false)
              onChange(candidate)
            } else {
              setInvalid(true)
            }
          }}
          onBlur={(e) => commit(e.target.value)}
          spellCheck={false}
          maxLength={7}
          placeholder="#RRGGBB"
          className={cnHex(invalid)}
        />
        {onReset && value && (
          <button
            type="button"
            onClick={() => { onReset(); setOpen(false) }}
            className="rounded p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
            aria-label={`${label} — reset`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {open && (
          <div className="absolute left-0 top-full z-50 mt-1 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900">
            <HexColorPicker
              color={value && HEX_RE.test(value) ? value : '#000000'}
              onChange={(next: string) => {
                setDraft(next)
                setInvalid(false)
                onChange(next)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
})
