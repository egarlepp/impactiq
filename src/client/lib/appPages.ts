import { CalendarDays, CalendarClock, LayoutDashboard, NotebookPen, History, LifeBuoy, Settings, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { hasPermission, type CurrentUser } from '../hooks/useCurrentUser.js'

// v1.420.0: the app's top-level pages, shared by the sidebar (nav.tsx) and the
// header's global search so both list the same pages under the same rules.

export type NavSectionKey = 'work' | 'insights' | 'learn' | 'admin'
export const NAV_SECTIONS: NavSectionKey[] = ['work', 'insights', 'learn', 'admin']

export interface AppPage {
  to: string
  labelKey: string
  icon: LucideIcon
  // Role Management page key; the page is hidden when the user lacks it.
  pageKey: string
  section: NavSectionKey
}

export const APP_PAGES: AppPage[] = [
  { to: '/', labelKey: 'nav.activities', icon: CalendarDays, pageKey: 'activities', section: 'work' },
  { to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, pageKey: 'dashboard', section: 'insights' },
  // Scheduling + My Notes are registered in Role Management and seeded
  // granted for every role (migration 0093), so everyone sees them by
  // default; admins can revoke via the page-key matrix. The page still
  // self-gates detail by role server-side.
  { to: '/scheduling', labelKey: 'nav.scheduling', icon: CalendarClock, pageKey: 'scheduling', section: 'work' },
  { to: '/notes', labelKey: 'nav.my_notes', icon: NotebookPen, pageKey: 'notes', section: 'work' },
  // v1.214.0: read-only pre-ImpactIQ Salesforce history. Seeded granted
  // for every role in migration 0111.
  { to: '/my-history', labelKey: 'nav.my_history', icon: History, pageKey: 'my_history', section: 'insights' },
  // My Settings (v1.360.0) isn't a sidebar link — it's the SlidersHorizontal
  // icon button in the sidebar footer, next to Logout (SETTINGS_PAGE below).
  // v1.255.0: in-app reference for when to use each activity type. Seeded
  // granted for every role in migration 0128.
  { to: '/guide', labelKey: 'nav.guide', icon: LifeBuoy, pageKey: 'guide', section: 'learn' },
  { to: '/admin', labelKey: 'nav.admin', icon: Settings, pageKey: 'admin', section: 'admin' },
]

export const SETTINGS_PAGE: Omit<AppPage, 'section'> = { to: '/settings', labelKey: 'nav.settings', icon: SlidersHorizontal, pageKey: 'settings' }

export function visibleAppPages(user: CurrentUser | null): AppPage[] {
  return APP_PAGES.filter((p) => hasPermission(user, p.pageKey))
}

// A link is active on its own path and anything below it (Guide on
// /guide/how-to-use), not only on an exact match. Activities also lives at
// /activities, so the root link claims that path too.
export function isNavLinkActive(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/' || pathname === '/activities' || pathname.startsWith('/activities/')
  return pathname === to || pathname.startsWith(`${to}/`)
}
