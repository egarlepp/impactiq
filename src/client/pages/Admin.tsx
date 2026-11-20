import { useState, useEffect, type ComponentType } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown, ChevronRight,
} from 'lucide-react'
import { ADMIN_CATEGORIES, GLOBAL_SECTIONS, LEGACY_SECTION_REDIRECTS, SECTION_ICONS, canOpenAdminSection, isSectionKey, type Section } from '../lib/adminSections.js'
import { useTeam } from '../hooks/useTeam.js'
import { useCurrentUser } from '../hooks/useCurrentUser.js'
import { PageHeader } from '../components/ui/page-header.js'
import { TeamSelector } from '../components/ui/nav.js'
import { TeamsConfig } from '../components/admin/TeamsConfig.js'
import { ActivityTypesConfig } from '../components/admin/ActivityTypesConfig.js'
import { SfFieldMappings } from '../components/admin/SfFieldMappings.js'
import { KeywordRulesConfig } from '../components/admin/KeywordRulesConfig.js'
import { AttachRateFieldsConfig } from '../components/admin/AttachRateFieldsConfig.js'
import { NudgeRulesConfig } from '../components/admin/NudgeRulesConfig.js'
import { CapacityGroupsConfig } from '../components/admin/CapacityGroupsConfig.js'
import { CostGroupsConfig } from '../components/admin/CostGroupsConfig.js'
import { UserManagement } from '../components/admin/UserManagement.js'
import { ThemingConfig } from '../components/admin/ThemingConfig.js'
import { IntegrationsStatus } from '../components/admin/IntegrationsStatus.js'
import { RateLimitConfig } from '../components/admin/RateLimitConfig.js'
import { EmailCommunicationsConfig } from '../components/admin/EmailCommunicationsConfig.js'
import { RoleManagement } from '../components/admin/RoleManagement.js'
import { AuditLog } from '../components/admin/AuditLog.js'
import { LoginHistory } from '../components/admin/LoginHistory.js'
import { ActivitiesImport } from '../components/admin/ActivitiesImport.js'
import { CrmSync } from '../components/admin/CrmSync.js'
import { NudgeHistory } from '../components/admin/NudgeHistory.js'
import { SchedulingConfig } from '../components/admin/SchedulingConfig.js'
import { DbHealth } from '../components/admin/DbHealth.js'
import { BackupRestore } from '../components/admin/BackupRestore.js'
import { useCrmLabelContext } from '../store/crmProvider.js'
import { HistoricalImport } from '../components/admin/HistoricalImport.js'
import { McpActivity } from '../components/admin/McpActivity.js'
import { McpServerConfig } from '../components/admin/McpServerConfig.js'
import { AiAssistantConfig } from '../components/admin/ai/AiAssistantConfig.js'
import { EventWebhooksConfig } from '../components/admin/EventWebhooksConfig.js'
import { DemoDataConfig } from '../components/admin/DemoDataConfig.js'
import { HolidayCalendarsConfig } from '../components/admin/HolidayCalendarsConfig.js'
import { FiscalYearConfig } from '../components/admin/FiscalYearConfig.js'
import { ProductsConfig } from '../components/admin/ProductsConfig.js'
import { SalesTeamAlignmentConfig } from '../components/admin/SalesTeamAlignmentConfig.js'
import { ActivityTemplatesAdmin } from '../components/admin/ActivityTemplatesAdmin.js'
import { FlightDeckConfig } from '../components/admin/FlightDeckConfig.js'
import { TerminologyConfig } from '../components/admin/TerminologyConfig.js'
import { AiAssessmentsConfig, type AiAssessmentsTab } from '../components/admin/AiAssessmentsConfig.js'
import { AnnouncementsConfig } from '../components/admin/AnnouncementsConfig.js'
import { ActivityHealth } from '../components/admin/ActivityHealth.js'
import { DynamicIcon } from '../components/ui/icon-picker.js'
import { Spinner } from '../components/ui/spinner.js'
import { cn } from '../lib/utils.js'

export default function Admin() {
  const { t } = useTranslation()
  const { activeTeam, active, loading, reloadTeams } = useTeam()
  const { user } = useCurrentUser()
  const isAppAdmin = !!user?.isAppAdmin
  const isAllTeamsSelected = active?.isAll === true
  // App Admins land on App Health (top of Monitoring); team admins land on
  // their first configuration screen.
  // v1.420.0: the open section lives in the URL (?section=<key>), like
  // VectorIQ's Admin, so a bookmark, the back button or a link from elsewhere
  // in the app can land on one screen. An unknown key falls back to the default.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedSection = searchParams.get('section')
  const legacyTarget = requestedSection ? LEGACY_SECTION_REDIRECTS[requestedSection]?.section : undefined
  const section: Section = isSectionKey(requestedSection) ? requestedSection : legacyTarget ?? (isAppAdmin ? 'db_health' : 'activity_types')
  const setSection = (key: Section, options?: { replace?: boolean }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('section', key)
      next.delete('tab')
      return next
    }, { replace: options?.replace ?? false })
  }
  // v1.461.0: a bookmark to a section that moved (Workplace → AI Notes)
  // lands on its new home instead of the default section.
  useEffect(() => {
    const moved = requestedSection ? LEGACY_SECTION_REDIRECTS[requestedSection] : undefined
    if (!moved) return
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('section', moved.section)
      if (moved.tab) next.set('tab', moved.tab)
      else next.delete('tab')
      return next
    }, { replace: true })
  }, [requestedSection, setSearchParams])
  // AI Assessments keeps its open tab in the URL too (?tab=assignments).
  const requestedTab = searchParams.get('tab')
  const aiAssessmentsTab: AiAssessmentsTab = requestedTab === 'assignments' || requestedTab === 'settings' ? requestedTab : 'assessments'
  const setAiAssessmentsTab = (tab: AiAssessmentsTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', tab)
      return next
    }, { replace: true })
  }

  const categories = ADMIN_CATEGORIES.map((c) => ({ key: c.key, label: t(c.labelKey), items: c.items }))

  // Collapsible sidebar categories. Only Monitoring & Audit is expanded by
  // default; whichever category holds the current section is force-open so the
  // active item is always visible.
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    const owning = categories.find((c) => (c.items as string[]).includes(section))
    if (owning) init[owning.key] = true
    return init
  })
  const toggleCat = (key: string) => setExpandedCats((prev) => ({ ...prev, [key]: !prev[key] }))

  // Every section now has a real key in all seven locales. The English-default
  // fallbacks that used to live here were shipping English to de/fr/es/ja/pt/it,
  // because i18next resolves a missing key to its defaultValue rather than to
  // the `en` bundle (CLAUDE.md §15).
  // CRM-specific section names (sf_mappings_hubspot = "HubSpot Field
  // Mappings") come through the i18next context.
  const crmCtx = useCrmLabelContext()
  const sectionLabel = (key: Section): string => t(`admin.sections.${key}`, { context: crmCtx })

  const visibleCategories = categories
    .map((c) => ({
      ...c,
      items: c.items.filter((k) => canOpenAdminSection(user, k)),
    }))
    .filter((c) => c.items.length > 0)

  const sections: { key: Section; label: string }[] = visibleCategories.flatMap((c) =>
    c.items.map((k) => ({ key: k, label: sectionLabel(k) })),
  )

  // If the current section is no longer visible (e.g. team admin landed on teams), shift to the first allowed one.
  useEffect(() => {
    if (!sections.some((s) => s.key === section) && sections[0]) {
      setSection(sections[0].key, { replace: true })
    }
  }, [sections, section])

  // Open the category holding the current section whenever it changes (a
  // back-button step or a link can land on a collapsed one).
  useEffect(() => {
    const owning = categories.find((c) => (c.items as string[]).includes(section))
    if (owning) setExpandedCats((prev) => (prev[owning.key] ? prev : { ...prev, [owning.key]: true }))
    // categories is rebuilt every render; only a section change should re-run this.
  }, [section])

  const isGlobalSection = GLOBAL_SECTIONS.includes(section)

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6" /></div>
  }

  const needsTeamForSection = !isGlobalSection && !activeTeam && !isAllTeamsSelected
  const activeCategory = visibleCategories.find((c) => c.items.includes(section))
  const HeaderIcon = SECTION_ICONS[section]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* v1.378.0: the page header spans the full width, starting at the main
          sidebar's edge; the second-tier Admin nav sits below it. */}
      <PageHeader
        icon={HeaderIcon}
        title={sections.find((s) => s.key === section)?.label ?? ''}
        subtitle={activeCategory ? `${t('nav.admin')} › ${activeCategory.label}` : null}
        right={!isGlobalSection ? <div className="w-56"><TeamSelector collapsed={false} /></div> : undefined}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Sidebar */}
      {/* v1.115.0: widened to w-60 so "Email Communications" (bolded when
          active) stays on one line without wrapping. Other long labels
          benefit too. */}
      <div className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white print:hidden dark:border-gray-700 dark:bg-gray-900">
        {/* v1.138.0: overflow-y-auto so the (long) secondary nav scrolls
            when it exceeds viewport height. Prior behavior clipped the
            bottom items on short screens. */}
        <nav className="flex flex-col gap-0.5 overflow-y-auto p-2">
          {visibleCategories.map((cat, idx) => {
            const open = expandedCats[cat.key] ?? false
            return (
            <div key={cat.key} className={cn('flex flex-col', idx > 0 && 'mt-1')}>
              {/* v1.420.0: VectorIQ's Admin nav — normal-case category
                  buttons, items indented beneath, and the active item in the
                  theme's primary colour rather than a fixed blue. */}
              <button
                type="button"
                onClick={() => toggleCat(cat.key)}
                aria-expanded={open}
                className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-900 transition-colors hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800"
              >
                <span>{cat.label}</span>
                {open ? <ChevronDown className="h-4 w-4 shrink-0 opacity-60" /> : <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />}
              </button>
              {open && (
                <div className="ml-2 mt-1 flex flex-col gap-0.5">
                  {cat.items.map((key) => {
                    const Icon = SECTION_ICONS[key]
                    const isActive = section === key
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSection(key)}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                          isActive
                            ? 'bg-[color:color-mix(in_srgb,var(--color-primary-light,#2563eb)_10%,transparent)] font-medium text-[color:var(--color-primary-light,#2563eb)] dark:bg-[color:color-mix(in_srgb,var(--color-primary-dark,#3b82f6)_18%,transparent)] dark:text-[color:var(--color-primary-dark,#60a5fa)]'
                            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{sectionLabel(key)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            )
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="relative flex-1 overflow-y-auto bg-gray-100 p-6 dark:bg-gray-900">
          {/* World watermark — background-image (not mask) so the SVG's
              wireframe and dotted continents come through, not just a
              silhouette. mix-blend on the page so it sits behind content.
              v1.331.0: world.webp previously used `background-size: auto
              115%` (height-driven, width left to the image's own aspect
              ratio) — on a wide window the image stopped covering the left
              portion of this div, leaving a visible seam of raw page
              background. A same-pass fix added a flat `backgroundColor`
              behind it to fill that gap, but that colored the ENTIRE div
              uniformly (including the area the image already covers,
              stacking on top of it), reading as "just too gray" rather than
              a seamless edge — wrong fix. `background-size: cover` is the
              actual correct tool here: it scales the image by the SAME
              factor in both dimensions (so it can never warp/stretch it
              unevenly, only crop the overflow) and, by definition, always
              fully covers the container at any width or height — no gap is
              possible, so no color patch is needed at all.
              v1.349.3: that guarantee only holds at a plain edge position —
              the `right -3rem` offset shifted the image 48px past the right
              edge, eating into the very horizontal overflow `cover` relies
              on to guarantee full coverage, and reopened an identical ~48px
              gap on the LEFT this time. Dropped the offset; `cover` at a
              plain `right center` position covers the container at any
              width with no gap, full stop — don't reintroduce an offset
              here without re-verifying full coverage at both a narrow and a
              very wide window.
              v1.355.0: world.webp's own pixels are near-black navy (avg RGB
              ~1,7,16) — built to `multiply` onto a light page background.
              `screen` blend only ever LIGHTENS using the blend layer's own
              color, so screening that same near-black asset onto the dark
              page background had almost nothing to lighten with and was
              invisible regardless of opacity. `invert(1)` flips it to
              near-white first so `screen` has something to actually lighten
              with — the dark-mode mirror of light mode's multiply-onto-white.
              v1.367.2: `absolute inset-0` on THIS div only ever stretched to
              the scroll container's own fixed viewport-height box (`flex-1`),
              never the taller `scrollHeight` a long admin section (e.g.
              Scheduling, User Management) grows to — so on any page tall
              enough to scroll, the watermark stopped partway down and left a
              flat, un-tinted gap below it. v1.367.2 tried a single-cell CSS
              grid overlay to stretch the watermark to the content's full
              height — reverted (v1.368.1): stretching the image into a much
              taller box changed its crop/zoom, visibly distorting it on long
              admin sections. Back to the original, non-stretched `absolute
              inset-0` sizing; the `bg-gray-100 dark:bg-gray-900` added to the
              scroll container itself (one step off the page's own
              `bg-gray-50`/`dark:bg-gray-950`, §20's PageShell) is what
              actually fixes the long-page gap — a plain element
              background-color always extends across the FULL scrollable
              height, unlike an absolutely positioned child pinned to the
              container's own CSS box, so scrolling past the image's bottom
              edge reveals this same tone instead of a mismatched blank patch.
              Do not reintroduce the grid wrapper — same fix applied in
              lockstep to Guide.tsx, HowToUseImpactIQ.tsx, and Settings.tsx. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-20 mix-blend-multiply dark:opacity-20 dark:mix-blend-screen dark:[filter:invert(1)]"
            style={{
              backgroundImage: "url('/world.webp')",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right center',
              backgroundSize: 'cover',
            }}
          />
          <div className="relative">
          {section === 'teams' && <TeamsConfig onTeamChange={reloadTeams} />}
          {section === 'theming' && <ThemingConfig />}
          {section === 'integrations' && <div className="flex flex-col gap-6"><IntegrationsStatus /><RateLimitConfig /></div>}
          {section === 'email_communications' && <EmailCommunicationsConfig />}
          {section === 'role_management' && <RoleManagement />}
          {section === 'audit_log' && <AuditLog />}
          {section === 'login_history' && <LoginHistory />}
          {section === 'activities_import' && <ActivitiesImport />}
          {section === 'crm_sync' && <CrmSync />}
          {section === 'activity_health' && <ActivityHealth />}
          {section === 'scheduling' && <SchedulingConfig />}
          {section === 'db_health' && <DbHealth />}
          {section === 'backup' && <BackupRestore />}
          {section === 'historical_import' && <HistoricalImport />}
          {section === 'mcp_server' && <McpServerConfig />}
          {section === 'ai_assistant' && <AiAssistantConfig />}
          {section === 'event_webhooks' && <EventWebhooksConfig />}
          {section === 'mcp_activity' && <McpActivity />}
          {section === 'demo_data' && <DemoDataConfig />}
          {section === 'calendars' && (
            <div className="flex flex-col gap-6">
              <FiscalYearConfig />
              <HolidayCalendarsConfig />
            </div>
          )}
          {section === 'products' && <ProductsConfig />}
          {section === 'terminology' && <TerminologyConfig />}
          {section === 'activity_templates' && <ActivityTemplatesAdmin />}
          {needsTeamForSection && (
            <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">
              {t('admin.teams.no_team_selected')}
            </p>
          )}
          {!needsTeamForSection && (isAllTeamsSelected || activeTeam) && (
            <>
              {section === 'activity_types' && (
                isAllTeamsSelected
                  ? <ActivityTypesConfig teamId="" globalView />
                  : <ActivityTypesConfig teamId={activeTeam!.id} />
              )}
              {section === 'nudge_history' && (
                isAllTeamsSelected
                  ? <NudgeHistory teamId="" globalView />
                  : <NudgeHistory teamId={activeTeam!.id} />
              )}
              {/* Capacity + cost groups are team-agnostic. */}
              {section === 'capacity_groups' && <CapacityGroupsConfig />}
              {section === 'cost_groups' && <CostGroupsConfig />}
              {/* These sections require a specific team — show prompt when All Teams is selected.
                  v1.318.0: 'users' moved out of this list — it now supports a genuine cross-team
                  "group by default team" view under All Teams instead of a dead end. */}
              {isAllTeamsSelected && ['sf_mappings','attach_rate_fields','keyword_rules','nudge_rules','flight_deck','announcements','ai_assessments'].includes(section) && (
                <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                  {t('admin.teams.select_specific_team')}
                </p>
              )}
              {isAllTeamsSelected && section === 'users' && <UserManagement teamId="" globalView />}
              {isAllTeamsSelected && section === 'sales_team_alignment' && <SalesTeamAlignmentConfig teamId="" globalView />}
              {!isAllTeamsSelected && activeTeam && (
                <>
                  {section === 'sf_mappings' && <SfFieldMappings teamId={activeTeam.id} />}
                  {section === 'attach_rate_fields' && <AttachRateFieldsConfig teamId={activeTeam.id} />}
                  {section === 'keyword_rules' && <KeywordRulesConfig teamId={activeTeam.id} />}
                  {section === 'nudge_rules' && <NudgeRulesConfig teamId={activeTeam.id} />}
                  {section === 'users' && <UserManagement teamId={activeTeam.id} />}
                  {section === 'flight_deck' && <FlightDeckConfig teamId={activeTeam.id} />}
                  {section === 'announcements' && <AnnouncementsConfig teamId={activeTeam.id} />}
                  {section === 'ai_assessments' && <AiAssessmentsConfig teamId={activeTeam.id} tab={aiAssessmentsTab} onTabChange={setAiAssessmentsTab} />}
                  {section === 'sales_team_alignment' && <SalesTeamAlignmentConfig teamId={activeTeam.id} />}
                </>
              )}
            </>
          )}
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
