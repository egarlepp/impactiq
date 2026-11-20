import { Link, useLocation, matchPath } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, XCircle, X, LogOut, ChevronRight, PanelLeftClose, PanelLeftOpen, Layers, ArrowUpCircle, SlidersHorizontal } from 'lucide-react'
import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { cn } from '../../lib/utils.js'
import { useTheme } from '../../store/theme.js'
import { useTeam, ALL_TEAMS_ID, type ActiveSelection } from '../../store/team.js'
import { useCurrentUser, hasPermission } from '../../hooks/useCurrentUser.js'
import { APP_VERSION } from '../../lib/version.js'
import type { ChangelogEntry } from '../../../shared/changelog.js'
import { Button } from './button.js'
import { ChangelogHighlights } from './changelog-highlights.js'
import { SfConnectButton } from './sf-connect-button.js'
import { DynamicIcon } from './icon-picker.js'
import { UpdateModal, type UpdateCheckStatus } from './UpdateModal.js'
import { api } from '../../lib/api.js'
import { formatDateTimeInTZ } from '../../lib/tz.js'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { closeMobileNav, useMobileNavOpen } from '../../store/mobileNav.js'
import { NAV_SECTIONS, isNavLinkActive, visibleAppPages } from '../../lib/appPages.js'

const COLLAPSED_KEY = 'nav_collapsed'

async function handleLogout() {
  // Use the shared api helper so the CSRF header goes along; a raw fetch
  // would be rejected by the double-submit middleware, leaving the session
  // intact and bouncing the user back after reload.
  try {
    const { api } = await import('../../lib/api.js')
    await api.post('/auth/logout', {})
  } catch {
    /* ignore — still reload */
  }
  window.location.assign('/')
}

// Clickable app-version chip. Opens a small popover listing the top 5
// changelog entries so users can see what recently shipped without
// leaving the app.
// v1.418.0: the changelog (250KB+) is loaded only when the popover first
// opens, so it no longer ships in the main bundle on every page load. The
// module promise is shared, so reopening the popover doesn't fetch it again.
let changelogPromise: Promise<ChangelogEntry[]> | null = null
function loadChangelog(): Promise<ChangelogEntry[]> {
  changelogPromise ??= import('../../../shared/changelog.js')
    .then((m) => m.CHANGELOG)
    .catch((err: unknown) => {
      changelogPromise = null // let the next open retry
      throw err
    })
  return changelogPromise
}

function ChangelogPopover() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    loadChangelog()
      .then((list) => { if (!cancelled) setEntries(list) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [])
  // Top 3 always expanded (current + two previous, matching VectorIQ since
  // v1.420.0). Next 25 collapse into one "Earlier releases" summary —
  // previously showed the entire rest of the changelog (400+ entries once
  // the project matured), which is far more than anyone opening this
  // popover actually wants to scroll through.
  const featured = entries?.slice(0, 3) ?? []
  const rest = entries?.slice(3, 28) ?? []
  return (
    <div className="absolute left-0 top-full z-40 mt-1 w-80 rounded-md border border-gray-200 bg-white p-2 text-xs text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
      <div className="mb-1 font-semibold">{t('changelog.title')}</div>
      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {!entries && !failed && (
          <div className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-gray-500 dark:text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('common.loading')}
          </div>
        )}
        {failed && (
          <div className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-red-600 dark:text-red-400">
            <XCircle className="h-3 w-3" />
            {t('changelog.load_failed')}
          </div>
        )}
        {featured.map((c, i) => (
          <div key={c.version} className={`rounded border p-1.5 ${i === 0 ? 'border-indigo-200 bg-indigo-50/50 dark:border-indigo-800 dark:bg-indigo-950/30' : 'border-gray-100 dark:border-gray-800'}`}>
            <div className="flex items-center justify-between text-[11px] font-semibold">
              <span className="flex items-center gap-1">
                v{c.version}
                {i === 0 && (
                  <span className="rounded-sm bg-indigo-600 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-white">
                    {t('changelog.current', 'Current')}
                  </span>
                )}
              </span>
              <span className="text-gray-400">{c.date}</span>
            </div>
            <ChangelogHighlights items={c.highlights} />
          </div>
        ))}
        {rest.length > 0 && (
          <div className="rounded border border-gray-100 dark:border-gray-800">
            <details>
              <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60">
                {t('changelog.earlier_releases', 'Earlier releases ({{count}})', { count: rest.length })}
              </summary>
              <div className="space-y-1.5 p-1.5">
                {rest.map((c) => (
                  <div key={c.version} className="rounded border border-gray-100 p-1.5 dark:border-gray-800">
                    <div className="flex items-center justify-between text-[11px] font-semibold">
                      <span>v{c.version}</span>
                      <span className="text-gray-400">{c.date}</span>
                    </div>
                    <ChangelogHighlights items={c.highlights} />
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}

function VersionChip({ textColor, updateAvailable }: { textColor: string; updateAvailable: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])
  return (
    <span className="relative flex leading-none" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 font-mono text-[9px] leading-none opacity-80 hover:underline hover:opacity-100"
        style={{ color: textColor }}
        title={t('changelog.view_recent')}
      >
        v{APP_VERSION}
        {/* v1.332.0: App Admin-only signal that a newer version exists on
            the pinned branch — see the sidebar Update pill for details. */}
        {updateAvailable && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            title={t('updates.available_indicator')}
          />
        )}
      </button>
      {open && <ChangelogPopover />}
    </span>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function AppNav() {
  const { t } = useTranslation()
  const location = useLocation()
  const { theme } = useTheme()
  const { user } = useCurrentUser()
  const [collapsedPref, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')
  // v1.419.0: on a phone the sidebar is a slide-in drawer, always shown
  // expanded, opened from PageHeader's menu button and closed on navigation.
  // The desktop collapse preference is kept untouched for the next wide screen.
  const isMobile = useIsMobile()
  const mobileOpen = useMobileNavOpen()
  const collapsed = !isMobile && collapsedPref
  useEffect(() => { closeMobileNav() }, [location.pathname])
  useEffect(() => {
    if (!isMobile || !mobileOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMobileNav() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isMobile, mobileOpen])

  // v1.332.0: App Update pill + version-chip dot — App Admin only. Fetches
  // the cached (not live) status once on mount; the modal's own "Check now"
  // (default admin only) refreshes it on demand. See UpdateModal.tsx.
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus | null>(null)
  const [updateModalOpen, setUpdateModalOpen] = useState(false)
  useEffect(() => {
    if (!user?.isAppAdmin) return
    let cancelled = false
    void api.get<UpdateCheckStatus | null>('/api/admin/updates/status').then((res) => {
      if (!cancelled) setUpdateStatus(res.data ?? null)
    })
    return () => { cancelled = true }
  }, [user?.isAppAdmin])

  // Compute active-link style per theme so inline styles don't override dark: classes
  const activeLinkStyle = useMemo(
    () =>
      theme === 'dark'
        ? {
            backgroundColor: 'var(--color-sidebar-highlight-dark, var(--color-sidebar-highlight, #1e3a6e))',
            color: 'var(--color-sidebar-active-text-dark, var(--color-sidebar-active-text, #93c5fd))',
          }
        : {
            backgroundColor: 'var(--color-sidebar-highlight-light, var(--color-sidebar-highlight, #eff6ff))',
            color: 'var(--color-sidebar-active-text-light, var(--color-sidebar-active-text, #1d4ed8))',
          },
    [theme],
  )

  const inactiveTextColor = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-sidebar-text-dark, var(--color-sidebar-text, #d1d5db))'
        : 'var(--color-sidebar-text-light, var(--color-sidebar-text, #4b5563))',
    [theme],
  )

  // Muted-text / border / pill-bg variants for the sidebar. Defaults match
  // the prior hardcoded Tailwind colors so legacy themes look identical
  // until an admin overrides them in Themes → Edit.
  const mutedTextColor = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-sidebar-text-muted-dark, #6b7280)'
        : 'var(--color-sidebar-text-muted-light, #9ca3af)',
    [theme],
  )
  const sidebarBorderColor = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-sidebar-border-dark, #374151)'
        : 'var(--color-sidebar-border-light, #e5e7eb)',
    [theme],
  )
  const navHoverBg = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-nav-hover-bg-dark, #1f2937)'
        : 'var(--color-nav-hover-bg-light, #f3f4f6)',
    [theme],
  )
  // Feeds the `hover:bg-[var(--nav-hover-bg)]` class on the nav links.
  const navHoverVar = { '--nav-hover-bg': navHoverBg } as CSSProperties
  const userPillName = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-user-pill-name-dark, #f3f4f6)'
        : 'var(--color-user-pill-name-light, #111827)',
    [theme],
  )
  const userPillSubtitle = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-user-pill-subtitle-dark, #9ca3af)'
        : 'var(--color-user-pill-subtitle-light, #6b7280)',
    [theme],
  )
  const sidebarPillBg = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-sidebar-pill-bg-dark, #1f2937)'
        : 'var(--color-sidebar-pill-bg-light, #f9fafb)',
    [theme],
  )
  // Sidebar "ImpactIQ" wordmark color. Falls back to the prior hardcoded
  // Tailwind blue (#2563eb light / #60a5fa dark, matching text-blue-600/
  // dark:text-blue-400) so a theme that hasn't set this yet looks identical.
  const appNameColor = useMemo(
    () =>
      theme === 'dark'
        ? 'var(--color-app-name-dark, #60a5fa)'
        : 'var(--color-app-name-light, #2563eb)',
    [theme],
  )

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsedPref))
  }, [collapsedPref])

  const links = visibleAppPages(user).map((p) => ({ ...p, label: t(p.labelKey) }))
  // v1.420.0: grouped under section headings like VectorIQ's sidebar; a
  // section with no visible link is dropped.
  const sections = NAV_SECTIONS
    .map((key) => ({ key, links: links.filter((l) => l.section === key) }))
    .filter((sec) => sec.links.length > 0)
  const settingsActive = location.pathname === '/settings' || location.pathname.startsWith('/settings/')
  const canSeeSettings = hasPermission(user, 'settings')

  // Top stop of the sidebar gradient, used as the collapsed toggle badge's
  // fill (matches VectorIQ: the badge hangs half outside the sidebar over the
  // page, so it carries the sidebar's own background and border with it).
  const sidebarTopBg =
    theme === 'dark'
      ? 'var(--color-sidebar-bg-dark-from, var(--color-sidebar-bg-dark, var(--color-sidebar-bg, #111827)))'
      : 'var(--color-sidebar-bg-light-from, var(--color-sidebar-bg-light, var(--color-sidebar-bg, #ffffff)))'
  const collapseLabel = isMobile ? t('nav.close_menu') : collapsed ? t('nav.expand_sidebar') : t('nav.collapse_sidebar')

  const updateModal = updateModalOpen && (
    <UpdateModal isDefaultAdmin={!!user?.isDefaultAdmin} onClose={() => setUpdateModalOpen(false)} />
  )
  if (isMobile && !mobileOpen) return updateModal || null

  const navEl = (
    <nav
      className={cn(
        'relative flex h-full flex-col border-r border-gray-200 bg-white px-2 py-4 transition-all duration-200 dark:border-gray-700 dark:bg-gray-900',
        collapsed ? 'w-20' : 'w-56',
        'print:hidden',
        // The phone drawer can be taller than the screen; the desktop sidebar
        // must not scroll, or it would clip the collapse badge hanging past its edge.
        isMobile && 'overflow-y-auto',
      )}
      style={{
        // Two-stop gradient falls back to the solid sidebar bg vars, which
        // themselves fall back to a hardcoded neutral. When from == to
        // (default state) it visually reads as a flat color, so the
        // change is invisible until an admin picks two distinct stops.
        backgroundImage:
          theme === 'dark'
            ? 'linear-gradient(180deg, var(--color-sidebar-bg-dark-from, var(--color-sidebar-bg-dark, var(--color-sidebar-bg, #111827))), var(--color-sidebar-bg-dark-to, var(--color-sidebar-bg-dark, var(--color-sidebar-bg, #111827))))'
            : 'linear-gradient(180deg, var(--color-sidebar-bg-light-from, var(--color-sidebar-bg-light, var(--color-sidebar-bg, #ffffff))), var(--color-sidebar-bg-light-to, var(--color-sidebar-bg-light, var(--color-sidebar-bg, #ffffff))))',
        borderRightColor:
          theme === 'dark'
            ? 'var(--color-border-dark, #374151)'
            : 'var(--color-border-light, #e5e7eb)',
      }}
    >
      {/* Header: logo + wordmark */}
      <div className={cn('mb-6 flex items-center', collapsed ? 'justify-center px-0' : 'justify-between gap-2 px-2')}>
        {collapsed ? (
          <img
            src="/logo-9-iq-spark-arcs.svg"
            alt="ImpactIQ"
            className="h-10 w-10"
          />
        ) : (
          <div className="flex items-center gap-2">
            <img
              src="/logo-9-iq-spark-arcs.svg"
              alt="ImpactIQ"
              className="h-8 w-8 shrink-0"
            />
            <div className="flex h-8 flex-col items-end justify-between">
              <span className="text-xl font-bold leading-none tracking-tight" style={{ color: appNameColor }}>ImpactIQ</span>
              <VersionChip textColor={appNameColor} updateAvailable={!!updateStatus?.updateAvailable} />
            </div>
          </div>
        )}
        {/* Collapse toggle, matching VectorIQ: inline panel icon next to the
            wordmark when expanded; a small round badge overlapping the logo's
            corner (half outside the sidebar) when collapsed. */}
        <button
          type="button"
          onClick={() => { if (isMobile) closeMobileNav(); else setCollapsed((c) => !c) }}
          aria-label={collapseLabel}
          title={collapseLabel}
          className={cn(
            'shrink-0 rounded-md p-1.5 transition-colors',
            collapsed && 'absolute -right-3 top-6 z-10 rounded-full border shadow-sm',
          )}
          style={{
            color: inactiveTextColor,
            ...(collapsed ? { backgroundColor: sidebarTopBg, borderColor: sidebarBorderColor } : {}),
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = navHoverBg }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = collapsed ? sidebarTopBg : '' }}
        >
          {isMobile ? <X className="h-5 w-5" /> : collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>

      {/* Nav links, grouped into sections. VectorIQ parity (v1.420.0):
          expanded, the active row is a full-width highlight with a chevron;
          collapsed, the highlight shrinks to a round badge behind the icon,
          and the row keeps the same height in both states (28px badge +
          py-1.5 = 40px = py-2.5 + 20px icon). */}
      <div className="flex flex-1 flex-col gap-4">
        {sections.map((sec) => (
          <div key={sec.key} role="group" aria-label={t(`nav.sections.${sec.key}`)}>
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6" style={{ backgroundColor: sidebarBorderColor }} aria-hidden="true" />
            ) : (
              <div className="truncate px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: mutedTextColor }}>
                {t(`nav.sections.${sec.key}`)}
              </div>
            )}
            <div className="flex flex-col gap-1">
              {sec.links.map(({ to, label, icon: Icon }) => {
                const active = isNavLinkActive(to, location.pathname)
                return (
                  <Link
                    key={to}
                    to={to}
                    title={label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center rounded-md px-3 text-sm font-medium transition-colors',
                      collapsed ? 'justify-center gap-0 px-0 py-1.5' : 'gap-3 py-2.5',
                      !active && 'hover:bg-[var(--nav-hover-bg)] hover:text-gray-900 dark:hover:text-gray-100',
                    )}
                    // Hover is a CSS class fed by a variable, never a DOM write
                    // in onMouseEnter: React can't see a hand-set background, so
                    // a clicked link kept it after it stopped being active
                    // (collapsed mode has no active background to overwrite it).
                    style={{ ...navHoverVar, ...(active ? (collapsed ? { color: activeLinkStyle.color } : activeLinkStyle) : { color: inactiveTextColor }) }}
                  >
                    <span
                      className={cn('flex shrink-0 items-center justify-center', collapsed && 'h-7 w-7 rounded-full')}
                      style={collapsed && active ? { backgroundColor: activeLinkStyle.backgroundColor } : undefined}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    {!collapsed && (
                      <>
                        <span className="truncate">{label}</span>
                        {active && <ChevronRight className="ml-auto h-4 w-4 shrink-0 opacity-50" />}
                      </>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer: team selector, SF status, settings, logout */}
      <div className="flex flex-col gap-2 border-t pt-3" style={{ borderTopColor: sidebarBorderColor }}>
        {!matchPath('/admin/*', location.pathname) && location.pathname !== '/admin' && (
          <TeamSelector collapsed={collapsed} />
        )}
        <SfConnectButton collapsed={collapsed} />
        <div className={cn('flex items-center gap-2', collapsed && 'flex-col gap-1')}>
          {/* v1.360.0: My Settings moved out of the regular link list into an
              icon-only button here, left of Logout — the theme toggle that
              previously sat here moved into My Settings → Preferences. */}
          {canSeeSettings && (
            <Link
              to="/settings"
              title={t('nav.settings')}
              aria-label={t('nav.settings')}
              aria-current={settingsActive ? 'page' : undefined}
              className={cn('flex h-9 w-9 items-center justify-center rounded-md transition-colors', !settingsActive && 'hover:bg-[var(--nav-hover-bg)]')}
              style={{ ...navHoverVar, ...(settingsActive ? activeLinkStyle : { color: mutedTextColor }) }}
            >
              <SlidersHorizontal className="h-5 w-5" />
            </Link>
          )}
          {/* Sign out turns red on hover, like VectorIQ's. The muted colour
              comes from a CSS variable so the hover class can override it. */}
          <button
            type="button"
            onClick={handleLogout}
            title={t('nav.logout')}
            aria-label={t('nav.logout')}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[color:var(--nav-muted)] transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            style={{ '--nav-muted': mutedTextColor } as CSSProperties}
          >
            <LogOut className="h-5 w-5" />
          </button>
          {/* v1.332.0: App Update pill — App Admin only, opens UpdateModal.
              Appended to this same flex container so it automatically sits
              to the right of Logout when expanded and below it when
              collapsed, matching the existing Theme/Logout layout. */}
          {user?.isAppAdmin && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setUpdateModalOpen(true)}
              title={t('updates.pill_title')}
              style={{ color: updateStatus?.updateAvailable ? undefined : mutedTextColor }}
              className={updateStatus?.updateAvailable ? 'text-amber-500 dark:text-amber-400' : undefined}
            >
              <ArrowUpCircle className="h-5 w-5" />
            </Button>
          )}
        </div>

        {/* User identity pill — VectorIQ parity (v1.420.0): an initials
            avatar in the theme's highlight colours, then name and email.
            Role, timezone and last login moved into the hover text. */}
        {user && (() => {
          const roleLabel = user.isAppAdmin ? t('nav.role_app_admin') : user.isAdmin ? t('nav.role_admin') : t('nav.role_contributor')
          // v1.364.0: "Last logged in" hover tooltip, in the user's own
          // timezone — appended to whichever tooltip/title this pill already
          // shows, so it works identically collapsed or expanded.
          const lastLoginLine = t('nav.last_login_tooltip', {
            when: user.lastLoginAt ? formatDateTimeInTZ(user.lastLoginAt, user.timezone) : t('nav.last_login_never'),
            defaultValue: 'Last logged in: {{when}}',
          })
          const details = [roleLabel, user.timezone, lastLoginLine].filter(Boolean).join('\n')
          const avatar = (
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
              style={{ backgroundColor: activeLinkStyle.backgroundColor, color: activeLinkStyle.color }}
              aria-hidden="true"
            >
              {initialsOf(user.displayName || user.email)}
            </span>
          )
          return collapsed ? (
            <div className="flex justify-center py-2" title={`${user.displayName}\n${user.email}\n${details}`}>
              {avatar}
            </div>
          ) : (
            <div
              className="flex items-center gap-3 rounded-md px-2 py-2"
              style={{ backgroundColor: sidebarPillBg }}
              title={details}
            >
              {avatar}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" style={{ color: userPillName }}>{user.displayName}</p>
                <p className="truncate text-xs" style={{ color: userPillSubtitle }}>{user.email}</p>
              </div>
            </div>
          )
        })()}
      </div>

    </nav>
  )

  return (
    <>
      {isMobile ? (
        <div className="fixed inset-0 z-50 flex print:hidden">
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={closeMobileNav} aria-hidden="true" />
          <div className="relative h-full max-w-[85vw]" role="dialog" aria-modal="true" aria-label={t('nav.menu')}>
            {navEl}
          </div>
        </div>
      ) : navEl}
      {updateModal}
    </>
  )
}

export function TeamSelector({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation()
  const { teams, active, setActive, canSeeAll } = useTeam()
  const [popupOpen, setPopupOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!popupOpen) return
    function close(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setPopupOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [popupOpen])

  if (teams.length === 0) return null
  const showSelector = teams.length > 1 || canSeeAll

  function handleSelect(id: string) {
    if (canSeeAll && id === ALL_TEAMS_ID) {
      setActive({ id: ALL_TEAMS_ID, name: t('nav.all_teams'), icon: null, role: 'admin', isAll: true })
    } else {
      const team = teams.find((tm) => tm.id === id)
      if (team) setActive({ id: team.id, name: team.name, icon: team.icon, role: team.role, isAll: false })
    }
    setPopupOpen(false)
  }

  const ActiveIcon = active?.isAll
    ? <Layers className={cn(collapsed ? 'h-5 w-5' : 'h-4 w-4', 'shrink-0 text-gray-500 dark:text-gray-400')} />
    : <DynamicIcon name={active?.icon ?? null} className={cn(collapsed ? 'h-5 w-5' : 'h-4 w-4', 'shrink-0 text-gray-500 dark:text-gray-400')} />

  if (!showSelector && active) {
    if (collapsed) {
      return (
        <div className="flex items-center justify-center py-1" title={active.name}>
          {ActiveIcon}
        </div>
      )
    }
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-gray-600 dark:text-gray-400">
        <DynamicIcon name={active.icon} className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{active.name}</span>
      </div>
    )
  }

  if (collapsed) {
    return (
      <div className="relative" ref={popupRef}>
        <button
          onClick={() => setPopupOpen((o) => !o)}
          title={active?.name ?? t('nav.team_select')}
          className="flex w-full items-center justify-center rounded-md px-2 py-1.5 text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          {ActiveIcon}
        </button>
        {popupOpen && (
          <div className="absolute bottom-full left-full mb-1 ml-2 z-50 w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
            {canSeeAll && (
              <button
                onClick={() => handleSelect(ALL_TEAMS_ID)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-800',
                  active?.isAll ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300',
                )}
              >
                <Layers className="h-3.5 w-3.5 shrink-0" />
                {t('nav.all_teams')}
              </button>
            )}
            {teams.map((tm) => (
              <button
                key={tm.id}
                onClick={() => handleSelect(tm.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-800',
                  active?.id === tm.id ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300',
                )}
              >
                <DynamicIcon name={tm.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tm.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-1">
      {active?.isAll ? (
        <Layers className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
      ) : (
        <DynamicIcon name={active?.icon ?? null} className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
      )}
      <select
        value={active?.id ?? ''}
        onChange={(e) => handleSelect(e.target.value)}
        className="w-full rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        title={t('nav.team_select')}
      >
        {canSeeAll && <option value={ALL_TEAMS_ID}>{t('nav.all_teams')}</option>}
        {teams.map((tm) => (
          <option key={tm.id} value={tm.id}>{tm.name}</option>
        ))}
      </select>
    </div>
  )
}
