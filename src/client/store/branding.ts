import { useSyncExternalStore } from 'react'
import { readableTextOn } from '../../shared/readableText.js'

export interface BrandLogos {
  logoLight: string | null
  logoDark: string | null
}

export interface ActiveThemeColors {
  primaryLight?: string
  primaryDark?: string
  surfaceLight?: string
  surfaceDark?: string
  linkLight?: string
  linkDark?: string
  pageBgLight?: string
  pageBgDark?: string
  borderLight?: string
  borderDark?: string
  headerLightFrom: string
  headerLightTo: string
  headerDarkFrom: string
  headerDarkTo: string
  sidebarBg?: string
  sidebarBgLight?: string
  sidebarBgDark?: string
  // Two-stop gradient for the sidebar. Optional — when absent the solid
  // sidebarBg* value is used for both from and to so the sidebar renders
  // as a flat color (legacy behavior).
  sidebarBgLightFrom?: string
  sidebarBgLightTo?: string
  sidebarBgDarkFrom?: string
  sidebarBgDarkTo?: string
  sidebarHighlight?: string
  sidebarHighlightLight?: string
  sidebarHighlightDark?: string
  sidebarText?: string
  sidebarTextLight?: string
  sidebarTextDark?: string
  sidebarActiveText?: string
  sidebarActiveTextLight?: string
  sidebarActiveTextDark?: string
  // Muted text — version label, "not configured" hints, user pill subtitle,
  // theme/logout/collapse icon buttons. Defaults to Tailwind gray-400/-500
  // when unset so legacy themes look identical.
  sidebarTextMutedLight?: string
  sidebarTextMutedDark?: string
  // Divider above footer block + user pill border.
  sidebarBorderLight?: string
  sidebarBorderDark?: string
  // User identity pill background.
  sidebarPillBgLight?: string
  sidebarPillBgDark?: string
  // v1.36 — nav item hover, user pill name + subtitle, top header text.
  navHoverBgLight?: string
  navHoverBgDark?: string
  userPillNameLight?: string
  userPillNameDark?: string
  userPillSubtitleLight?: string
  userPillSubtitleDark?: string
  headerTextLight?: string
  headerTextDark?: string
  // v1.358 — sidebar wordmark ("ImpactIQ") text color. Defaults to the
  // legacy hardcoded Tailwind blue (text-blue-600/dark:text-blue-400) when
  // unset so existing themes render identically.
  appNameLight?: string
  appNameDark?: string
  pageHeaderIconLight?: string
  pageHeaderIconDark?: string
}

let current: BrandLogos = { logoLight: null, logoDark: null }
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setBrandLogos(next: BrandLogos) {
  current = next
  listeners.forEach((cb) => { cb() })
}

export function useBrandLogos(): BrandLogos {
  return useSyncExternalStore(subscribe, () => current, () => current)
}

// v1.371.0: admin-configured support contact address (Admin → Themes →
// Support contact email), read once by App.tsx (the authenticated shell) and
// shared here the same way brand logos are, so PageHeader's help icon on
// every page doesn't each re-fetch it. Null/unset means "hide the icon" —
// there's no placeholder address to fall back to.
let currentSupportEmail: string | null = null
const supportEmailListeners = new Set<() => void>()

function subscribeSupportEmail(cb: () => void) {
  supportEmailListeners.add(cb)
  return () => { supportEmailListeners.delete(cb) }
}

export function setSupportEmail(next: string | null) {
  currentSupportEmail = next
  supportEmailListeners.forEach((cb) => { cb() })
}

export function useSupportEmail(): string | null {
  return useSyncExternalStore(subscribeSupportEmail, () => currentSupportEmail, () => currentSupportEmail)
}

// Track the last-applied signature so debounced/repeated calls with
// identical inputs skip the ~30 setProperty writes and avoid
// unnecessary full-document style invalidation.
let lastAppliedSignature: string | null = null

export function applyThemeColors(colors: ActiveThemeColors) {
  const signature = JSON.stringify(colors)
  if (signature === lastAppliedSignature) return
  lastAppliedSignature = signature
  const root = document.documentElement.style
  if (colors.primaryLight) root.setProperty('--color-primary-light', colors.primaryLight)
  if (colors.primaryDark) root.setProperty('--color-primary-dark', colors.primaryDark)
  // Button text follows the primary color's brightness so a light primary
  // (Gray / Dark presets in dark mode) still gets readable text.
  const primaryFgLight = colors.primaryLight ? readableTextOn(colors.primaryLight) : undefined
  const primaryFgDark = colors.primaryDark ? readableTextOn(colors.primaryDark) : undefined
  if (primaryFgLight) root.setProperty('--color-primary-fg-light', primaryFgLight)
  else root.removeProperty('--color-primary-fg-light')
  if (primaryFgDark) root.setProperty('--color-primary-fg-dark', primaryFgDark)
  else root.removeProperty('--color-primary-fg-dark')
  if (colors.surfaceLight) root.setProperty('--color-surface-light', colors.surfaceLight)
  if (colors.surfaceDark) root.setProperty('--color-surface-dark', colors.surfaceDark)
  if (colors.linkLight) root.setProperty('--color-link-light', colors.linkLight)
  if (colors.linkDark) root.setProperty('--color-link-dark', colors.linkDark)
  if (colors.pageBgLight) root.setProperty('--color-page-bg-light', colors.pageBgLight)
  if (colors.pageBgDark) root.setProperty('--color-page-bg-dark', colors.pageBgDark)
  if (colors.borderLight) root.setProperty('--color-border-light', colors.borderLight)
  if (colors.borderDark) root.setProperty('--color-border-dark', colors.borderDark)
  root.setProperty('--color-header-light-from', colors.headerLightFrom)
  root.setProperty('--color-header-light-to', colors.headerLightTo)
  root.setProperty('--color-header-dark-from', colors.headerDarkFrom)
  root.setProperty('--color-header-dark-to', colors.headerDarkTo)
  const sidebarBgLight = colors.sidebarBgLight ?? colors.sidebarBg
  const sidebarBgDark = colors.sidebarBgDark ?? colors.sidebarBg
  if (sidebarBgLight) root.setProperty('--color-sidebar-bg-light', sidebarBgLight)
  if (sidebarBgDark) root.setProperty('--color-sidebar-bg-dark', sidebarBgDark)
  if (colors.sidebarBg) root.setProperty('--color-sidebar-bg', colors.sidebarBg)
  // Gradient stops. Fall back to the solid sidebarBg* so an unset gradient
  // is indistinguishable from the legacy flat color.
  const bgLightFrom = colors.sidebarBgLightFrom ?? sidebarBgLight
  const bgLightTo = colors.sidebarBgLightTo ?? sidebarBgLight
  const bgDarkFrom = colors.sidebarBgDarkFrom ?? sidebarBgDark
  const bgDarkTo = colors.sidebarBgDarkTo ?? sidebarBgDark
  if (bgLightFrom) root.setProperty('--color-sidebar-bg-light-from', bgLightFrom)
  if (bgLightTo) root.setProperty('--color-sidebar-bg-light-to', bgLightTo)
  if (bgDarkFrom) root.setProperty('--color-sidebar-bg-dark-from', bgDarkFrom)
  if (bgDarkTo) root.setProperty('--color-sidebar-bg-dark-to', bgDarkTo)
  const sidebarHighlightLight = colors.sidebarHighlightLight ?? colors.sidebarHighlight
  const sidebarHighlightDark = colors.sidebarHighlightDark ?? colors.sidebarHighlight
  if (sidebarHighlightLight) root.setProperty('--color-sidebar-highlight-light', sidebarHighlightLight)
  if (sidebarHighlightDark) root.setProperty('--color-sidebar-highlight-dark', sidebarHighlightDark)
  if (colors.sidebarHighlight) root.setProperty('--color-sidebar-highlight', colors.sidebarHighlight)
  const sidebarTextLight = colors.sidebarTextLight ?? colors.sidebarText
  const sidebarTextDark = colors.sidebarTextDark ?? colors.sidebarText
  if (sidebarTextLight) root.setProperty('--color-sidebar-text-light', sidebarTextLight)
  if (sidebarTextDark) root.setProperty('--color-sidebar-text-dark', sidebarTextDark)
  if (colors.sidebarText) root.setProperty('--color-sidebar-text', colors.sidebarText)
  const sidebarActiveTextLight = colors.sidebarActiveTextLight ?? colors.sidebarActiveText
  const sidebarActiveTextDark = colors.sidebarActiveTextDark ?? colors.sidebarActiveText
  if (sidebarActiveTextLight) root.setProperty('--color-sidebar-active-text-light', sidebarActiveTextLight)
  if (sidebarActiveTextDark) root.setProperty('--color-sidebar-active-text-dark', sidebarActiveTextDark)
  if (colors.sidebarActiveText) root.setProperty('--color-sidebar-active-text', colors.sidebarActiveText)
  if (colors.sidebarTextMutedLight) root.setProperty('--color-sidebar-text-muted-light', colors.sidebarTextMutedLight)
  if (colors.sidebarTextMutedDark) root.setProperty('--color-sidebar-text-muted-dark', colors.sidebarTextMutedDark)
  if (colors.sidebarBorderLight) root.setProperty('--color-sidebar-border-light', colors.sidebarBorderLight)
  if (colors.sidebarBorderDark) root.setProperty('--color-sidebar-border-dark', colors.sidebarBorderDark)
  if (colors.sidebarPillBgLight) root.setProperty('--color-sidebar-pill-bg-light', colors.sidebarPillBgLight)
  if (colors.sidebarPillBgDark) root.setProperty('--color-sidebar-pill-bg-dark', colors.sidebarPillBgDark)
  if (colors.navHoverBgLight) root.setProperty('--color-nav-hover-bg-light', colors.navHoverBgLight)
  if (colors.navHoverBgDark) root.setProperty('--color-nav-hover-bg-dark', colors.navHoverBgDark)
  if (colors.userPillNameLight) root.setProperty('--color-user-pill-name-light', colors.userPillNameLight)
  if (colors.userPillNameDark) root.setProperty('--color-user-pill-name-dark', colors.userPillNameDark)
  if (colors.userPillSubtitleLight) root.setProperty('--color-user-pill-subtitle-light', colors.userPillSubtitleLight)
  if (colors.userPillSubtitleDark) root.setProperty('--color-user-pill-subtitle-dark', colors.userPillSubtitleDark)
  if (colors.headerTextLight) root.setProperty('--color-header-text-light', colors.headerTextLight)
  if (colors.headerTextDark) root.setProperty('--color-header-text-dark', colors.headerTextDark)
  if (colors.appNameLight) root.setProperty('--color-app-name-light', colors.appNameLight)
  if (colors.appNameDark) root.setProperty('--color-app-name-dark', colors.appNameDark)
  // Cleared when unset so a theme switch doesn't keep the previous theme's icon
  // color; the header then falls back to the theme's primary color.
  if (colors.pageHeaderIconLight) root.setProperty('--color-page-header-icon-light', colors.pageHeaderIconLight)
  else root.removeProperty('--color-page-header-icon-light')
  if (colors.pageHeaderIconDark) root.setProperty('--color-page-header-icon-dark', colors.pageHeaderIconDark)
  else root.removeProperty('--color-page-header-icon-dark')
}
