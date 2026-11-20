import { type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Mail, Menu, PlaneTakeoff } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '../../store/theme.js'
import { useBrandLogos, useSupportEmail } from '../../store/branding.js'
import { NotificationBell } from './notifications.js'
import { QuarterCountdown } from './quarter-countdown.js'
import { LanguagePicker } from './language-picker.js'
import { useFlightDeckAvailable, openFlightDeck } from '../../store/flightDeck.js'
import { openMobileNav } from '../../store/mobileNav.js'
import { GlobalSearch } from './global-search.js'
import { useCurrentUser, hasPermission } from '../../hooks/useCurrentUser.js'
import { howToUseHref, howToUseSectionForPath } from '../../lib/howToUse.js'

// Re-opens the Flight Deck modal on demand — only rendered once the user's
// current preference is known to have it on (FlightDeckModal reports this
// after its own fetch), so it disappears the moment "Don't show again" /
// the My Settings toggle turns it off, and reappears if turned back on.
function FlightDeckButton() {
  const { t } = useTranslation()
  const available = useFlightDeckAvailable()
  if (!available) return null
  return (
    <button
      type="button"
      onClick={openFlightDeck}
      title={t('settings.flight_deck.header_button', 'Open Flight Deck checklist')}
      aria-label={t('settings.flight_deck.header_button', 'Open Flight Deck checklist')}
      className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
    >
      <PlaneTakeoff className="h-4 w-4" />
    </button>
  )
}

interface PageHeaderProps {
  icon: ComponentType<{ className?: string; style?: React.CSSProperties; 'aria-hidden'?: boolean | 'true' | 'false' }>
  title: string
  subtitle?: string | null
  right?: React.ReactNode
}

export function PageHeader({ icon: Icon, title, subtitle, right }: PageHeaderProps) {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { logoLight, logoDark } = useBrandLogos()
  const logo = theme === 'dark' ? (logoDark ?? logoLight) : (logoLight ?? logoDark)
  const supportEmail = useSupportEmail()
  const { user } = useCurrentUser()
  const { pathname } = useLocation()
  // v1.420.0: like VectorIQ's ?, this opens the manual at the section for
  // the page you're on. Shown to anyone who can open the Guide.
  const helpHref = hasPermission(user, 'guide') ? howToUseHref(howToUseSectionForPath(pathname)) : null

  const style =
    theme === 'dark'
      ? {
          backgroundImage:
            'linear-gradient(rgba(30,58,110,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(30,58,110,0.6) 1px, transparent 1px), linear-gradient(135deg, var(--color-header-dark-from, #1A1536) 0%, var(--color-header-dark-to, #1E3A6E) 100%)',
          backgroundSize: '28px 28px, 28px 28px, 100% 100%',
        }
      : {
          backgroundImage:
            'linear-gradient(rgba(88,81,219,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(88,81,219,0.06) 1px, transparent 1px), linear-gradient(135deg, var(--color-header-light-from, #ffffff) 0%, var(--color-header-light-to, #E8E6F8) 100%)',
          backgroundSize: '28px 28px, 28px 28px, 100% 100%',
        }

  // overflow-x-clip, not overflow-hidden: the header's dropdowns (language,
  // notifications) hang below its 64px height and overflow-hidden cut them off.
  // Clip on x only still keeps a crowded phone header from spilling sideways.
  return (
    <div
      className="relative flex h-16 shrink-0 items-center print:hidden justify-between gap-2 overflow-x-clip border-b border-gray-200 px-3 md:gap-4 md:px-6 dark:border-gray-700"
      style={{
        ...style,
        borderBottomColor:
          theme === 'dark'
            ? 'var(--color-border-dark, #374151)'
            : 'var(--color-border-light, #e5e7eb)',
      }}
    >
      {/* v1.420.0: VectorIQ's top bar — a fixed 64px height and the world-map
          watermark over the right side, on top of ImpactIQ's own grid pattern.
          Same blend as the Admin watermark: multiply on light, inverted and
          screened on dark (the asset is near-black). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-20 mix-blend-multiply dark:opacity-20 dark:mix-blend-screen dark:[filter:invert(1)]"
        style={{ backgroundImage: "url('/world.webp')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right center', backgroundSize: 'cover' }}
      />
      {/* Title row matches VectorIQ's topbar: 20px icon in the theme's page-header
          icon color, bold 18px title, then a smaller muted description. */}
      <div className="relative flex min-w-0 flex-1 items-center gap-2.5">
        {/* v1.419.0: phone only — opens the sidebar drawer (AppNav). */}
        <button
          type="button"
          onClick={openMobileNav}
          title={t('nav.open_menu')}
          aria-label={t('nav.open_menu')}
          className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-900 md:hidden dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Icon
          className="h-5 w-5 shrink-0"
          style={{
            color:
              theme === 'dark'
                ? 'var(--color-page-header-icon-dark, var(--color-primary-dark, #60A5FA))'
                : 'var(--color-page-header-icon-light, var(--color-primary-light, #2563EB))',
          }}
          aria-hidden="true"
        />
        <h1
          className="min-w-0 shrink truncate text-lg font-bold tracking-tight md:max-w-[50%] md:shrink-0"
          title={title}
          style={{
            color:
              theme === 'dark'
                ? 'var(--color-header-text-dark, #f3f4f6)'
                : 'var(--color-header-text-light, #111827)',
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className="hidden min-w-0 items-center gap-1.5 text-sm text-[#4B5768] md:flex dark:text-[#94A3B8]"
            title={subtitle}
          >
            {/* A drawn dash, centred on the text by flex, so it sits mid-height
                in every font instead of wherever the font puts its em dash. */}
            <span aria-hidden="true" className="h-px w-3.5 shrink-0 bg-current" />
            <span className="min-w-0 truncate">{subtitle}</span>
          </p>
        )}
      </div>
      <div className="relative flex shrink-0 items-center gap-1">
        {right}
        {/* On a phone the header keeps only the actions; the quarter pill,
            language picker and brand logo come back from the md breakpoint. */}
        <div className="hidden md:contents">
          <QuarterCountdown />
        </div>
        <FlightDeckButton />
        <div className="hidden md:contents">
          <LanguagePicker variant="dark" />
        </div>
        <GlobalSearch />
        {helpHref && (
          <Link
            to={helpHref}
            title={t('search.help_for_page')}
            aria-label={t('search.help_for_page')}
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            <HelpCircle className="h-4 w-4" />
          </Link>
        )}
        {/* The support mailbox moved off the ? (now in-app help) to its own
            envelope icon, still shown only when an address is configured. */}
        {supportEmail && (
          <a
            href={`mailto:${supportEmail}?subject=ImpactIQ%20support`}
            title={t('login.help_email_hint', 'Email support for help')}
            aria-label={t('login.help_email_hint', 'Email support for help')}
            className="hidden h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 md:flex dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            <Mail className="h-4 w-4" />
          </a>
        )}
        <NotificationBell />
        {logo && <img src={logo} alt="Brand logo" className="hidden h-8 max-w-[140px] shrink-0 object-contain object-right md:block" />}
      </div>
    </div>
  )
}
