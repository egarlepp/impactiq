import express, { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { backupRouter } from './backup.js'
import { aiAdminRouter } from './aiAdmin.js'
import { requireGlobalAdmin } from '../middleware/rbac.js'
import { monitoringRoutes } from './admin/monitoring.js'
import { teamsAdminRoutes } from './admin/teams.js'
import { usersAdminRoutes } from './admin/users.js'
import { activityTypesRoutes } from './admin/activityTypes.js'
import { fieldMappingsRoutes } from './admin/fieldMappings.js'
import { rulesRoutes } from './admin/rules.js'
import { flightDeckRoutes } from './admin/flightDeck.js'
import { capacityCostRoutes } from './admin/capacityCost.js'
import { teamMembersRoutes } from './admin/teamMembers.js'
import { themesAdminRoutes } from './admin/themes.js'
import { crmMetadataRoutes } from './admin/crmMetadata.js'
import { integrationsRoutes } from './admin/integrations.js'
import { calendarsRoutes } from './admin/calendars.js'
import { catalogRoutes } from './admin/catalog.js'
import { alignmentRoutes } from './admin/alignment.js'
import { workWeekRoutes } from './admin/workWeek.js'
import { schedulingRoutes } from './admin/scheduling.js'
import { historicalImportRoutes } from './admin/historicalImport.js'
import { systemRoutes } from './admin/system.js'
import { eventWebhooksRoutes } from './admin/eventWebhooks.js'
import { terminologyRoutes } from './admin/terminology.js'
import { aiNotesAdminRoutes } from './admin/aiNotes.js'
import { aiAssessmentsAdminRoutes } from './admin/aiAssessments.js'

// Kept importable from here for existing callers (adminTeamScoping.test.ts).
export { isKeywordRuleVisibleToTeam, isNudgeRuleVisibleToTeam } from './admin/rules.js'

export const adminRouter = Router()

// v1.95.0: admin routes accept larger JSON payloads — the global
// express.json({ limit: '256kb' }) mounted in index.ts rejects theme +
// product icon uploads (a 1 MB PNG serialises to ~1.33 MB base64, so
// admins would upload, hit 413, and see the field stay blank on reload).
// 8 MB gives comfortable headroom for the current 1 MB product-icon cap
// and 2 MB theme-logo cap without opening the door to abuse — the admin
// router is already gated behind requireAppAdmin.
const adminJson = express.json({ limit: '8mb' })
// GET/HEAD bodies are never parsed, same as the app-wide parser (audit H1).
adminRouter.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') { next(); return }
  adminJson(req, res, next)
})

// v1.322.0: registered BEFORE the blanket requireGlobalAdmin gate below —
// read-only fiscal-year display config (how quarters/years are labelled
// app-wide) is needed by every signed-in user, not just admins/leaders.
// It previously inherited the router's admin-only baseline, so a plain
// Contributor's GET silently 401'd and useFiscalConfig.ts's client-side
// catch fell back to its hardcoded calendar-year default — the exact
// "Q3 2026" instead of the org's real "Q3 FY27" symptom this fixes. Write
// access (PATCH below) stays requireAppAdmin, unaffected by this move.
adminRouter.get('/fiscal-year', requireAuth, async (_req, res) => {
  const { getFiscalConfig } = await import('../services/config/fiscal.js')
  res.json({ data: await getFiscalConfig(), error: null, meta: {} })
})

// v1.333.0: same "needed by every signed-in user, not just admins" shape as
// fiscal-year above — MaintenanceBanner.tsx polls this for every user so
// the scheduled-restart announcement/countdown/confirmation shows app-wide,
// not just to admins. Write access (PUT/DELETE, further down this file)
// stays requireDefaultAdmin, unaffected by this move.
adminRouter.get('/maintenance-window', requireAuth, async (_req, res) => {
  const { getMaintenanceWindow } = await import('../services/updates/maintenanceWindow.js')
  res.json({ data: await getMaintenanceWindow(), error: null, meta: {} })
})

// Global gate: must be admin on at least one team. Team-scoped routes layer
// requireRole('admin') on top to enforce admin-on-this-team.
adminRouter.use(requireAuth, requireGlobalAdmin)

// Admin → Monitoring & Audit → Backup & Restore (CLAUDE.md §14d). The sub-
// router adds its own requireAppAdmin on top of this gate.
adminRouter.use('/backup', backupRouter)
adminRouter.use('/ai', aiAdminRouter)

// v1.416.0: the admin routes live in ./admin/, one module per screen area.
// They are mounted in the order they used to appear in this file, so route
// matching order is unchanged, and every one sits behind the gate above.
adminRouter.use(monitoringRoutes)
adminRouter.use(teamsAdminRoutes)
adminRouter.use(usersAdminRoutes)
adminRouter.use(activityTypesRoutes)
adminRouter.use(fieldMappingsRoutes)
adminRouter.use(rulesRoutes)
adminRouter.use(flightDeckRoutes)
adminRouter.use(aiNotesAdminRoutes)
adminRouter.use(aiAssessmentsAdminRoutes)
adminRouter.use(capacityCostRoutes)
adminRouter.use(teamMembersRoutes)
adminRouter.use(themesAdminRoutes)
adminRouter.use(crmMetadataRoutes)
adminRouter.use(integrationsRoutes)
adminRouter.use(calendarsRoutes)
adminRouter.use(catalogRoutes)
adminRouter.use(alignmentRoutes)
adminRouter.use(workWeekRoutes)
adminRouter.use(schedulingRoutes)
adminRouter.use(historicalImportRoutes)
adminRouter.use(systemRoutes)
adminRouter.use(eventWebhooksRoutes)
adminRouter.use(terminologyRoutes)
