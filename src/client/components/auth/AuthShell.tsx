import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Moon, Sun, HelpCircle } from 'lucide-react'
import { useTheme } from '../../store/theme.js'
import { useBrandLogos, setBrandLogos, applyThemeColors, type ActiveThemeColors } from '../../store/branding.js'
import { APP_VERSION } from '../../lib/version.js'
import { LanguagePicker } from '../ui/language-picker.js'
import { resolveLoginLogoSize } from '../../../shared/loginLogoSize.js'
import { trimImageDataUrl } from '../../lib/trimImage.js'

// v1.117.0: shared branded shell for every pre-auth page (Login,
// ForgotPassword, ResetPassword). Renders the dark gradient, the world
// watermark, top-left theme toggle, top-right language + help chips,
// bottom-left version stamp, and the centered brand logo above the
// child card. Any new pre-auth page should wrap itself in <AuthShell>
// so the app stays visually consistent behind the modal.
//
// v1.352.0: `scrollable` opt-in for a page whose content can genuinely
// exceed one viewport (the Setup wizard) — the default (false) layout uses
// `overflow-hidden` + vertical centering, which is correct for the other
// three short, fixed-height pages but would silently clip a taller page
// with no way to scroll to what's cut off. When true: the outer container
// drops `align-items: center` for `align-items: flex-start` (top-aligned,
// matching the Setup wizard's own original non-centered layout) and swaps
// `overflow-hidden` for `overflow-y-auto` — `align-items: center` combined
// with `overflow-y-auto` is a well-known flexbox pitfall where content
// taller than the container gets clipped on the leading edge with no way
// to scroll up to it, so centering the cross axis and allowing scroll on
// it can't safely coexist here; horizontal centering (`justify-center`,
// the row-direction main axis) has no such overflow risk and is kept as-is.
// The corner chrome (theme toggle, language/help, version stamp) and the
// watermark switch from `absolute` to `fixed` so they stay pinned to the
// viewport during a scroll instead of scrolling away with the content —
// behaviorally identical to `absolute` on the three pages that never
// scroll, so this is applied unconditionally rather than gated on the
// prop. The centered header logo is hidden in scrollable mode since the
// Setup wizard already renders its own icon+title header inside the card.
// How long the card must keep the same height before the login logo is
// revealed (see cardSettled below).
const CARD_SETTLE_MS = 250

export function AuthShell({ children, scrollable = false, contentReady = true }: {
  children: React.ReactNode
  scrollable?: boolean
  // False while the page is still loading something that changes the card's
  // size (Login's SSO provider check). The login logo waits for it.
  contentReady?: boolean
}) {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { logoLight, logoDark } = useBrandLogos()
  // v1.371.0: admin-configurable support contact (Admin → Themes →
  // Support contact email), read via the genuinely-public
  // /api/themes/support-email endpoint since there's no session yet on any
  // page this shell wraps. Null/unset hides the help icon entirely rather
  // than linking to a placeholder address.
  const [supportEmail, setSupportEmail] = useState<string | null>(null)
  // App-wide login screen logo (Admin → Themes → Login screen logo). When
  // set it wins over the active theme's logo for the big graphic above the
  // card; unset falls back to the theme logo exactly as before. undefined
  // means the request hasn't answered yet: nothing is shown until it does,
  // so the theme logo never flashes before the login logo replaces it.
  const [loginLogo, setLoginLogo] = useState<string | null | undefined>(undefined)
  // Admin-set display size (px) for the login logo; null = default by the
  // image's shape (750×200 for a rectangle, 250×250 for a square). Needs
  // the image's natural size, so it's measured on load and the logo stays
  // invisible until then to avoid a visible resize.
  const [loginLogoSize, setLoginLogoSize] = useState<{ width: number | null; height: number | null }>({ width: null, height: null })
  const [loginLogoNatural, setLoginLogoNatural] = useState<{ width: number; height: number } | null>(null)
  // The stored image with its empty border cropped off, so the artwork
  // itself fills the configured box instead of the padding around it.
  const [loginLogoSrc, setLoginLogoSrc] = useState<string | null>(null)
  // Height of the card stack, so the logo above it can be capped to the
  // free space between the top of the screen and the card.
  const cardRef = useRef<HTMLDivElement>(null)
  const [cardHeight, setCardHeight] = useState(0)
  // The card grows as the page finishes loading (e.g. an SSO button appears
  // once the provider check answers), which changes the space the logo may
  // use on short screens. The logo waits for contentReady and then for the
  // card to keep one height for CARD_SETTLE_MS, so it appears once at its
  // final size.
  const [cardSettled, setCardSettled] = useState(false)
  // Once shown, the logo stays shown: later card changes (moving to the MFA
  // step, an error message) just resize it instead of hiding it again.
  const [logoShown, setLogoShown] = useState(false)

  useEffect(() => { restartSettle.current() }, [contentReady])

  useEffect(() => {
    if (loginLogoNatural && contentReady && cardSettled) setLogoShown(true)
  }, [loginLogoNatural, contentReady, cardSettled])

  useEffect(() => {
    let cancelled = false
    setLoginLogoNatural(null)
    setLogoShown(false)
    if (!loginLogo) { setLoginLogoSrc(null); return }
    void trimImageDataUrl(loginLogo).then((src) => { if (!cancelled) setLoginLogoSrc(src) })
    return () => { cancelled = true }
  }, [loginLogo])

  const restartSettle = useRef<() => void>(() => {})
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      setCardHeight(el.offsetHeight)
      setCardSettled(false)
      clearTimeout(timer)
      timer = setTimeout(() => setCardSettled(true), CARD_SETTLE_MS)
    }
    restartSettle.current = update
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [])

  useEffect(() => {
    fetch('/api/themes/active', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: { colors?: ActiveThemeColors | null; logoLight?: string | null; logoDark?: string | null } | null }) => {
        if (j.data?.colors) applyThemeColors(j.data.colors)
        setBrandLogos({ logoLight: j.data?.logoLight ?? null, logoDark: j.data?.logoDark ?? null })
      })
      .catch(() => { /* keep defaults */ })
    fetch('/api/themes/support-email', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: { email?: string | null } | null }) => setSupportEmail(j.data?.email ?? null))
      .catch(() => { /* keep hidden */ })
    fetch('/api/themes/login-logo', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: { dataUrl?: string | null; width?: number | null; height?: number | null } | null }) => {
        setLoginLogo(j.data?.dataUrl ?? null)
        setLoginLogoSize({ width: j.data?.width ?? null, height: j.data?.height ?? null })
      })
      .catch(() => setLoginLogo(null)) // fall back to theme logo
  }, [])

  const ThemeIcon = theme === 'dark' ? Sun : Moon
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  // Background is always the dark gradient regardless of app theme, so the
  // dark-mode brand logo (designed for dark backgrounds) is always the right pick.
  // A dedicated app-wide login logo, when configured, takes precedence and
  // renders in flow above the card at its configured/default size; the
  // theme-logo fallback keeps its original fixed placement.
  const themeLogo = logoDark ?? logoLight
  const loginLogoBox = resolveLoginLogoSize(loginLogoNatural ?? { width: 0, height: 0 }, loginLogoSize)

  return (
    <div
      className={`relative flex min-h-screen justify-center ${scrollable ? 'items-start overflow-y-auto' : 'items-center overflow-hidden'}`}
      style={{ background: 'linear-gradient(to right, #050b39 0%, #001cab 100%)' }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          backgroundImage: "url('/world.webp')",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
          backgroundSize: 'cover',
        }}
      />

      <button
        type="button"
        onClick={() => setTheme(nextTheme)}
        title={t(`theme.${nextTheme}`)}
        className="fixed left-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20"
      >
        <ThemeIcon className="h-4 w-4" />
      </button>

      <div className="fixed right-4 top-4 z-10 flex items-center gap-2">
        <LanguagePicker />
        {supportEmail && (
          <a
            href={`mailto:${supportEmail}?subject=ImpactIQ%20support`}
            title={t('login.help_email_hint')}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20"
          >
            <HelpCircle className="h-4 w-4" />
          </a>
        )}
      </div>

      <p
        className="fixed bottom-1 left-2 z-10 font-mono text-white/60"
        style={{ fontSize: '6px' }}
      >
        v{APP_VERSION}
      </p>

      {!scrollable && loginLogo === null && themeLogo && (
        <img
          src={themeLogo}
          alt="Brand"
          className="absolute z-10 max-w-[60vw] object-contain drop-shadow-2xl"
          style={{ top: '12vh', left: '50%', transform: 'translateX(-50%)', height: '9rem' }}
        />
      )}

      {/* The card stays vertically centered exactly as it does without a
          logo; the login logo is anchored just above it, capped to the free
          space between the top of the screen and the card, so adding a
          large logo never pushes the card down. */}
      <div ref={cardRef} className="relative z-10 flex w-full flex-col items-center gap-4 px-4">
        {!scrollable && loginLogoSrc && (
          <img
            src={loginLogoSrc}
            alt="Brand"
            onLoad={(e) => setLoginLogoNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            className="absolute bottom-full left-1/2 mb-8 -translate-x-1/2 object-contain object-bottom drop-shadow-2xl"
            style={{
              width: `${loginLogoBox.width}px`,
              height: `min(${loginLogoBox.height}px, max(3rem, calc((100vh - ${cardHeight}px) / 2 - 3rem)))`,
              maxWidth: 'calc(100vw - 2rem)',
              opacity: logoShown ? 1 : 0,
            }}
          />
        )}
        {children}
      </div>
    </div>
  )
}
