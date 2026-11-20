import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { activitiesRouter } from './activities.js'
import { teamsRouter } from './teams.js'
import { dashboardsRouter } from './dashboards.js'
import { adminRouter } from './admin.js'
import { salesforceRouter } from './salesforce.js'
import { aiRouter } from './ai.js'
import { nudgesRouter } from './nudges.js'
import { notificationsRouter } from './notifications.js'
import { outlookRouter } from './outlook.js'
import { templatesRouter } from './templates.js'
import { nonActivitiesRouter } from './non-activities.js'
import { notesRouter } from './notes.js'
import { schedulingRouter } from './scheduling.js'
import { historyRouter } from './history.js'
import { flightDeckRouter } from './flightDeck.js'
import { crmRouter } from './crm.js'
import { criteriaiqRouter } from './criteriaiq.js'
import { gongRouter } from './gong.js'
import { aiNotesRouter } from './aiNotes.js'
import { aiAssessmentsRouter } from './aiAssessments.js'
import { getTerminology } from '../services/config/terminology.js'

export const apiRouter = Router()

apiRouter.use(requireAuth)

apiRouter.get('/me', (req, res) => {
  res.json({ data: req.user ?? null, error: null, meta: {} })
})

// The org's word for an evaluation (Admin → Workplace → Terminology), for the
// {{evalTerm}} / {{evalWork}} wording in every screen.
apiRouter.get('/terminology', async (_req, res) => {
  res.json({ data: await getTerminology(), error: null, meta: {} })
})

apiRouter.use('/activities', activitiesRouter)
apiRouter.use('/teams', teamsRouter)
apiRouter.use('/dashboards', dashboardsRouter)
apiRouter.use('/admin', adminRouter)
apiRouter.use('/salesforce', salesforceRouter)
apiRouter.use('/ai', aiRouter)
apiRouter.use('/nudges', nudgesRouter)
apiRouter.use('/notifications', notificationsRouter)
apiRouter.use('/outlook', outlookRouter)
apiRouter.use('/templates', templatesRouter)
apiRouter.use('/non-activities', nonActivitiesRouter)
apiRouter.use('/notes', notesRouter)
apiRouter.use('/scheduling', schedulingRouter)
apiRouter.use('/history', historyRouter)
apiRouter.use('/flight-deck', flightDeckRouter)
apiRouter.use('/crm', crmRouter)
apiRouter.use('/criteriaiq', criteriaiqRouter)
apiRouter.use('/gong', gongRouter)
apiRouter.use('/ai-notes', aiNotesRouter)
apiRouter.use('/ai-assessments', aiAssessmentsRouter)
