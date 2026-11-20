import { Sparkles, CalendarDays, CalendarClock, Cloud, Bell, LineChart, NotebookPen, ShieldCheck, ClipboardCheck, SlidersHorizontal, HelpCircle, type LucideIcon } from 'lucide-react'

// v1.420.0: the How to Use ImpactIQ manual's sections, shared by the page
// itself, the header's ? button (help for the page you're on) and the global
// search, so all three point at the same anchors.

export type HowToUseSectionId = 'overview' | 'contributor' | 'salesforce' | 'nudges' | 'leader' | 'scheduling' | 'notes' | 'admin' | 'criteriaiq' | 'settings' | 'faq'

// Icons mirror the real sidebar's own icon for each page (nav.tsx) where one
// exists — CalendarDays/CalendarClock/NotebookPen match Activities/
// Scheduling/My Notes exactly — so the table of contents reads as the same
// visual language as the app itself, not a set of icons invented for this
// page alone.
export const HOW_TO_USE_SECTIONS: { id: HowToUseSectionId; icon: LucideIcon }[] = [
  { id: 'overview', icon: Sparkles },
  { id: 'contributor', icon: CalendarDays },
  { id: 'salesforce', icon: Cloud },
  { id: 'nudges', icon: Bell },
  { id: 'leader', icon: LineChart },
  { id: 'scheduling', icon: CalendarClock },
  { id: 'notes', icon: NotebookPen },
  { id: 'admin', icon: ShieldCheck },
  // v1.453.0: setting up the CriteriaIQ link end to end, in both apps. Same
  // icon as the CriteriaIQ source on Admin → Integrations.
  { id: 'criteriaiq', icon: ClipboardCheck },
  { id: 'settings', icon: SlidersHorizontal },
  { id: 'faq', icon: HelpCircle },
]

// v1.421.0: the page a section explains, by Role Management key. Search only
// offers a section whose page the user can open; sections about the app as a
// whole (overview, Salesforce, nudges, FAQ) are for everyone.
export const HOW_TO_USE_SECTION_PAGE_KEY: Partial<Record<HowToUseSectionId, string>> = {
  contributor: 'activities',
  leader: 'dashboard',
  scheduling: 'scheduling',
  notes: 'notes',
  admin: 'admin',
  criteriaiq: 'admin',
  settings: 'settings',
}

export function howToUseHref(id: HowToUseSectionId): string {
  return `/guide/how-to-use#howto-${id}`
}

// Which section of the manual covers the page at this path. Pages with no
// section of their own (My History, the Guide itself, a 404) land on the overview.
export function howToUseSectionForPath(pathname: string): HowToUseSectionId {
  const first = pathname.split('/')[1] ?? ''
  switch (first) {
    case '':
    case 'activities': return 'contributor'
    case 'dashboard': return 'leader'
    case 'scheduling': return 'scheduling'
    case 'notes': return 'notes'
    case 'admin': return 'admin'
    case 'settings': return 'settings'
    default: return 'overview'
  }
}
