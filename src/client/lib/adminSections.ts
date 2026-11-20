import type { ComponentType } from 'react'
import {
  Building2, ListChecks, ArrowLeftRight, BellRing, Users, Tags, BarChart3, Palette, Plug, ShieldCheck, Sparkles, CalendarClock, Package, FileClock, Monitor, Upload, DollarSign, Handshake, History, Bookmark, Mail, Clock, Bot, Activity as ActivityIcon, Link2, Gauge, RefreshCw, PlaneTakeoff, HeartPulse, Megaphone, DatabaseBackup, Webhook, SpellCheck, ClipboardCheck,
} from 'lucide-react'
import { hasPermission, type CurrentUser } from '../hooks/useCurrentUser.js'

// v1.420.0: the Admin section model (keys, categories, icons and who can open
// each), moved out of pages/Admin.tsx so the header's global search lists
// exactly the sections the Admin page would show, from the same source.

export type Section =
  | 'teams'
  | 'activity_types'
  | 'sf_mappings'
  | 'attach_rate_fields'
  | 'keyword_rules'
  | 'nudge_rules'
  | 'capacity_groups'
  | 'cost_groups'
  | 'users'
  | 'role_management'
  | 'demo_data'
  | 'theming'
  | 'integrations'
  | 'calendars'
  | 'products'
  | 'flight_deck'
  | 'announcements'
  | 'terminology'
  | 'ai_assessments'
  | 'audit_log'
  | 'login_history'
  | 'activities_import'
  | 'crm_sync'
  | 'nudge_history'
  | 'activity_health'
  | 'sales_team_alignment'
  | 'activity_templates'
  | 'email_communications'
  | 'scheduling'
  | 'db_health'
  | 'historical_import'
  | 'mcp_server'
  | 'ai_assistant'
  | 'event_webhooks'
  | 'mcp_activity'
  | 'backup'

export const GLOBAL_SECTIONS: Section[] = ['teams', 'theming', 'integrations', 'email_communications', 'role_management', 'demo_data', 'calendars', 'products', 'audit_log', 'login_history', 'crm_sync', 'activity_health', 'capacity_groups', 'cost_groups', 'activity_templates', 'scheduling', 'db_health', 'mcp_server', 'ai_assistant', 'event_webhooks', 'mcp_activity', 'historical_import', 'backup', 'terminology']

// Sections only the App Admin can see. Team admins manage day-to-day rules,
// users, picklists and capacity, but cannot touch SF field mappings, theming,
// or the team registry itself. Activities import is available to team_admin
// too so they can bulk-import their team's backlog. Capacity + cost groups
// span teams, so they're app-admin only too.
// v1.83.0: APP_ADMIN_ONLY is now a *security floor* — sections a team_admin
// can never see even if the Role Management matrix would grant it, because
// they'd let a team_admin escalate their own or a peer's access. Everything
// else is governed by SECTION_TO_PAGE_KEY + hasPermission below.
// Terminology (v1.446.0) renames Activity Types on every team.
export const APP_ADMIN_ONLY: Section[] = ['teams', 'role_management', 'email_communications', 'historical_import', 'backup', 'ai_assistant', 'event_webhooks', 'terminology']

export const SECTION_ICONS: Record<Section, ComponentType<{ className?: string }>> = {
  teams: Building2,
  activity_types: ListChecks,
  sf_mappings: ArrowLeftRight,
  attach_rate_fields: Link2,
  nudge_rules: BellRing,
  users: Users,
  keyword_rules: Tags,
  capacity_groups: BarChart3,
  cost_groups: DollarSign,
  theming: Palette,
  integrations: Plug,
  role_management: ShieldCheck,
  demo_data: Sparkles,
  calendars: CalendarClock,
  products: Package,
  flight_deck: PlaneTakeoff,
  announcements: Megaphone,
  terminology: SpellCheck,
  ai_assessments: ClipboardCheck,
  audit_log: FileClock,
  login_history: Monitor,
  activities_import: Upload,
  crm_sync: RefreshCw,
  nudge_history: BellRing,
  activity_health: HeartPulse,
  sales_team_alignment: Handshake,
  activity_templates: Bookmark,
  email_communications: Mail,
  scheduling: Clock,
  db_health: Gauge,
  historical_import: History,
  mcp_server: Bot,
  ai_assistant: Sparkles,
  event_webhooks: Webhook,
  mcp_activity: ActivityIcon,
  backup: DatabaseBackup,
}

// Old section keys that moved: Workplace → AI Notes is now the Settings tab
// of Activities & Rules → AI Assessments (v1.461.0).
export const LEGACY_SECTION_REDIRECTS: Record<string, { section: Section; tab?: string }> = {
  ai_notes: { section: 'ai_assessments', tab: 'settings' },
}

export function isSectionKey(value: string | null): value is Section {
  return value !== null && Object.prototype.hasOwnProperty.call(SECTION_ICONS, value)
}

// Sidebar is grouped into non-clickable category headers with their
// menu items underneath. Demo Data always lives in its own final group
// so it's visually separated from real configuration.
export const ADMIN_CATEGORIES: { key: string; labelKey: string; items: Section[] }[] = [
  {
    key: 'activities',
    labelKey: 'admin.categories.activities',
    items: ['activity_types', 'keyword_rules', 'nudge_rules', 'ai_assessments', 'sf_mappings', 'attach_rate_fields', 'activities_import', 'activity_templates'],
  },
  {
    key: 'people',
    labelKey: 'admin.categories.people',
    items: ['teams', 'users', 'role_management', 'capacity_groups', 'cost_groups', 'sales_team_alignment'],
  },
  {
    key: 'workplace',
    labelKey: 'admin.categories.workplace',
    items: ['calendars', 'products', 'terminology', 'flight_deck', 'announcements'],
  },
  {
    key: 'integrations_cat',
    labelKey: 'admin.categories.integrations',
    items: ['integrations', 'ai_assistant', 'event_webhooks', 'email_communications', 'mcp_server', 'historical_import'],
  },
  {
    key: 'appearance',
    labelKey: 'admin.categories.appearance',
    items: ['theming'],
  },
  {
    key: 'monitoring',
    labelKey: 'admin.categories.monitoring',
    items: ['db_health', 'audit_log', 'login_history', 'crm_sync', 'nudge_history', 'activity_health', 'scheduling', 'backup'],
  },
  {
    key: 'demo',
    labelKey: 'admin.categories.demo',
    items: ['demo_data'],
  },
]

// v1.81.0: for non-app-admins, respect the Role Management matrix's
// admin.* checkboxes on top of the APP_ADMIN_ONLY floor. Sections whose
// page key isn't in the role_permissions vocabulary fall back to the
// legacy APP_ADMIN_ONLY behavior so nothing team-admins used to see
// silently vanishes.
export const SECTION_TO_PAGE_KEY: Record<Section, string> = {
  activity_types: 'admin.activity_types',
  keyword_rules: 'admin.keyword_rules',
  nudge_rules: 'admin.nudge_rules',
  sf_mappings: 'admin.sf_mappings',
  attach_rate_fields: 'admin.sf_mappings',
  activities_import: 'admin.activities_import',
  activity_templates: 'admin.activity_templates',
  teams: 'admin.teams',
  users: 'admin.users',
  role_management: 'admin.role_management',
  capacity_groups: 'admin.capacity',
  cost_groups: 'admin.cost_groups',
  sales_team_alignment: 'admin.sales_team_alignment',
  calendars: 'admin.calendars',
  products: 'admin.products',
  flight_deck: 'admin.flight_deck',
  announcements: 'admin.announcements',
  terminology: 'admin.terminology',
  // v1.461.0: AI Assessments replaced Workplace → AI Notes and kept its
  // Role Management key, so existing grants carry over.
  ai_assessments: 'admin.ai_notes',
  integrations: 'admin.integrations',
  email_communications: 'admin.email_communications',
  theming: 'admin.themes',
  audit_log: 'admin.audit_log',
  login_history: 'admin.login_history',
  crm_sync: 'admin.crm_sync',
  nudge_history: 'admin.nudge_history',
  activity_health: 'admin.activity_health',
  demo_data: 'admin.demo_data',
  scheduling: 'admin.scheduling',
  db_health: 'admin.db_health',
  historical_import: 'admin.historical_import',
  mcp_server: 'admin.mcp_server',
  ai_assistant: 'admin.ai_assistant',
  event_webhooks: 'admin.event_webhooks',
  mcp_activity: 'admin.mcp_activity',
  backup: 'admin.backup',
}

/** Whether this user can open an Admin section: App Admins see everything;
 *  others need the section's Role Management page key, and never get an
 *  APP_ADMIN_ONLY section whatever the matrix says. */
export function canOpenAdminSection(user: CurrentUser | null, key: Section): boolean {
  if (user?.isAppAdmin) return true
  if (APP_ADMIN_ONLY.includes(key)) return false
  return hasPermission(user, SECTION_TO_PAGE_KEY[key])
}
