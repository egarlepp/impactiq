import { Router } from 'express'
import { db } from '../../db/index.js'
import { users, holidayCalendars, holidayDates, userHolidayCalendars } from '../../../../drizzle/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { z } from 'zod'
import { logAudit } from '../../services/audit/log.js'

export const calendarsRoutes = Router()

// --- Demo data generator (app-admin only) ---

calendarsRoutes.get('/demo-data/status', requireAppAdmin, async (_req, res) => {
  const { demoDataStatus } = await import('../../services/demo/generator.js')
  const status = await demoDataStatus()
  res.json({ data: status, error: null, meta: {} })
})

// The Demo Data form's settings. Every field is optional on Reseed, where
// a missing one keeps the stored value.
const demoSettingsShape = {
  contributorCount: z.number().int().min(1).max(20),
  weeksBack: z.number().int().min(1).max(52),
  createLeaderLogin: z.boolean(),
  timezone: z.string().max(64).nullable(),
  approvedPct: z.number().int().min(0).max(100),
  declinedPct: z.number().int().min(0).max(100),
  oooPct: z.number().int().min(0).max(60),
  ptoDaysPerPerson: z.number().int().min(0).max(20),
  // Cleaned (trimmed, de-duplicated, capped at 50 × 80 chars) by the generator.
  activityNames: z.array(z.string().max(200)).max(200),
}

async function checkTimezone(tz: string | null | undefined): Promise<boolean> {
  if (!tz) return true
  const { isValidTimeZone } = await import('../../services/demo/timezone.js')
  return isValidTimeZone(tz)
}

calendarsRoutes.post('/demo-data/generate', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    contributorCount: demoSettingsShape.contributorCount.default(6),
    weeksBack: demoSettingsShape.weeksBack.default(12),
    includeAdmin: z.boolean().default(true),
    createLeaderLogin: demoSettingsShape.createLeaderLogin.default(false),
    timezone: demoSettingsShape.timezone.optional(),
    approvedPct: demoSettingsShape.approvedPct.optional(),
    declinedPct: demoSettingsShape.declinedPct.optional(),
    oooPct: demoSettingsShape.oooPct.optional(),
    ptoDaysPerPerson: demoSettingsShape.ptoDaysPerPerson.optional(),
    activityNames: demoSettingsShape.activityNames.optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  if (!(await checkTimezone(parsed.data.timezone))) { res.status(400).json({ data: null, error: 'errors.demo_data.invalid_timezone', meta: {} }); return }
  try {
    const { generateDemoData, DemoDataExistsError } = await import('../../services/demo/generator.js')
    try {
      const result = await generateDemoData({ ...parsed.data, adminUserId: req.user!.id })
      // The leader's password is stored encrypted for Current state; it is
      // never logged.
      await logAudit(req, {
        action: 'demo_data.generate',
        targetType: 'team',
        targetId: result.teamId,
        meta: { users: result.usersCreated, activities: result.activitiesCreated, leaderLogin: result.leaderLogin?.email ?? null, timezone: parsed.data.timezone ?? null },
      })
      res.json({ data: result, error: null, meta: {} })
    } catch (err) {
      if (err instanceof DemoDataExistsError) { res.status(409).json({ data: null, error: err.message, meta: {} }); return }
      throw err
    }
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : 'Demo generation failed', meta: {} })
  }
})

// POST /api/admin/demo-data/reseed — remove every demo row and generate
// again from the stored settings, with any overrides in the body.
calendarsRoutes.post('/demo-data/reseed', requireAppAdmin, async (req, res) => {
  const schema = z.object(demoSettingsShape).partial()
  const parsed = schema.safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  if (!(await checkTimezone(parsed.data.timezone))) { res.status(400).json({ data: null, error: 'errors.demo_data.invalid_timezone', meta: {} }); return }
  try {
    const { reseedDemoData } = await import('../../services/demo/generator.js')
    const overrides = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined))
    const result = await reseedDemoData({ adminUserId: req.user!.id, overrides })
    await logAudit(req, {
      action: 'demo_data.reseed',
      targetType: 'team',
      targetId: result.teamId,
      meta: { users: result.usersCreated, activities: result.activitiesCreated, leaderLogin: result.leaderLogin?.email ?? null },
    })
    res.json({ data: result, error: null, meta: {} })
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : 'Demo reseed failed', meta: {} })
  }
})

calendarsRoutes.delete('/demo-data', requireAppAdmin, async (req, res) => {
  const { removeDemoData } = await import('../../services/demo/generator.js')
  const result = await removeDemoData()
  await logAudit(req, { action: 'demo_data.remove', targetType: 'team', meta: result })
  res.json({ data: result, error: null, meta: {} })
})

// --- Holiday calendars ---
// POST /api/admin/holiday-calendars — create a new (usually custom) calendar.
calendarsRoutes.post('/holiday-calendars', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    code: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, - and _ only'),
    name: z.string().min(1).max(120),
    locale: z.string().min(2).max(20).default('en-US'),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [existing] = await db.select({ id: holidayCalendars.id }).from(holidayCalendars).where(eq(holidayCalendars.code, parsed.data.code)).limit(1)
  if (existing) { res.status(409).json({ data: null, error: `Calendar code "${parsed.data.code}" already exists`, meta: {} }); return }
  const [row] = await db.insert(holidayCalendars).values({
    code: parsed.data.code,
    name: parsed.data.name,
    locale: parsed.data.locale,
  }).returning()
  res.status(201).json({ data: row, error: null, meta: {} })
})

// DELETE /api/admin/holiday-calendars/:id — delete a calendar (cascades to
// dates + user/team assignments via FK ON DELETE CASCADE).
calendarsRoutes.delete('/holiday-calendars/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  await db.delete(holidayCalendars).where(eq(holidayCalendars.id, id))
  res.json({ data: { id }, error: null, meta: {} })
})

// POST /api/admin/holiday-calendars/refresh — pull fresh public-holiday
// dates for every ISO-country calendar for the current + next year. Custom
// calendars (non-2-letter codes) are left alone.
calendarsRoutes.post('/holiday-calendars/refresh', requireAppAdmin, async (req, res) => {
  const { refreshAllCalendars } = await import('../../services/holidays/refresh.js')
  const now = new Date()
  const years = [now.getUTCFullYear(), now.getUTCFullYear() + 1]
  try {
    const results = await refreshAllCalendars(years)
    res.json({ data: { years, results }, error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof Error ? err.message : 'Holiday refresh failed', meta: {} })
  }
})

// POST /api/admin/holiday-calendars/:id/refresh — refresh one specific
// calendar for the given years (default: current + next).
calendarsRoutes.post('/holiday-calendars/:id/refresh', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const { refreshCalendar } = await import('../../services/holidays/refresh.js')
  const now = new Date()
  const years = Array.isArray(req.body?.years) && req.body.years.every((y: unknown) => typeof y === 'number')
    ? req.body.years as number[]
    : [now.getUTCFullYear(), now.getUTCFullYear() + 1]
  try {
    const r = await refreshCalendar(id, years)
    res.json({ data: { calendarId: id, years, ...r }, error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof Error ? err.message : 'Holiday refresh failed', meta: {} })
  }
})

// GET /api/admin/holiday-calendars — list all calendars with their date counts.
calendarsRoutes.get('/holiday-calendars', requireAppAdmin, async (_req, res) => {
  const cals = await db.select().from(holidayCalendars).orderBy(holidayCalendars.name)
  const dateCounts = await db
    .select({ calendarId: holidayDates.calendarId, n: sql<string>`count(*)` })
    .from(holidayDates)
    .groupBy(holidayDates.calendarId)
  const countMap = new Map(dateCounts.map((r) => [r.calendarId, Number(r.n)]))
  res.json({
    data: cals.map((c) => ({ ...c, dateCount: countMap.get(c.id) ?? 0 })),
    error: null,
    meta: {},
  })
})

// GET /api/admin/holiday-calendars/:id/dates — read the seeded dates for review.
calendarsRoutes.get('/holiday-calendars/:id/dates', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const rows = await db.select().from(holidayDates).where(eq(holidayDates.calendarId, id)).orderBy(holidayDates.date)
  res.json({ data: rows, error: null, meta: {} })
})

// GET /api/admin/holiday-calendars/assignments — per-user calendar assignments.
calendarsRoutes.get('/holiday-calendars/assignments', requireAppAdmin, async (_req, res) => {
  const rows = await db
    .select({
      userId: userHolidayCalendars.userId,
      calendarId: userHolidayCalendars.calendarId,
      userEmail: users.email,
      userDisplayName: users.displayName,
    })
    .from(userHolidayCalendars)
    .innerJoin(users, eq(userHolidayCalendars.userId, users.id))
  res.json({ data: rows, error: null, meta: {} })
})

// PUT /api/admin/holiday-calendars/assignments/:userId — replace the set for a user (max 3).
calendarsRoutes.put('/holiday-calendars/assignments/:userId', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  const schema = z.object({ calendarIds: z.array(z.string().uuid()).max(3) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db.delete(userHolidayCalendars).where(eq(userHolidayCalendars.userId, userId))
  if (parsed.data.calendarIds.length > 0) {
    await db.insert(userHolidayCalendars).values(parsed.data.calendarIds.map((cid) => ({ userId, calendarId: cid })))
  }
  res.json({ data: { userId, calendarIds: parsed.data.calendarIds }, error: null, meta: {} })
})

// POST /api/admin/holiday-calendars/:id/dates — add a date to a calendar.
calendarsRoutes.post('/holiday-calendars/:id/dates', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    name: z.string().min(1).max(200),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [inserted] = await db
    .insert(holidayDates)
    .values({ calendarId: id, date: parsed.data.date, name: parsed.data.name })
    .onConflictDoUpdate({ target: [holidayDates.calendarId, holidayDates.date], set: { name: parsed.data.name } })
    .returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

// DELETE /api/admin/holiday-calendars/:id/dates/:dateId — remove a date.
calendarsRoutes.delete('/holiday-calendars/:id/dates/:dateId', requireAppAdmin, async (req, res) => {
  const { id, dateId } = req.params as { id: string; dateId: string }
  await db.delete(holidayDates).where(and(eq(holidayDates.id, dateId), eq(holidayDates.calendarId, id)))
  res.json({ data: { id: dateId }, error: null, meta: {} })
})

// GET /api/admin/teams/:teamId/holiday-calendars — get calendar IDs assigned to a team.
calendarsRoutes.get('/teams/:teamId/holiday-calendars', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { teamHolidayCalendars } = await import('../../../../drizzle/schema.js')
  const rows = await db.select({ calendarId: teamHolidayCalendars.calendarId })
    .from(teamHolidayCalendars).where(eq(teamHolidayCalendars.teamId, teamId))
  res.json({ data: rows.map((r) => r.calendarId), error: null, meta: {} })
})

// PUT /api/admin/teams/:teamId/holiday-calendars — replace the set (max 3).
calendarsRoutes.put('/teams/:teamId/holiday-calendars', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({ calendarIds: z.array(z.string().uuid()).max(3) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamHolidayCalendars } = await import('../../../../drizzle/schema.js')
  await db.delete(teamHolidayCalendars).where(eq(teamHolidayCalendars.teamId, teamId))
  if (parsed.data.calendarIds.length > 0) {
    await db.insert(teamHolidayCalendars).values(parsed.data.calendarIds.map((cid) => ({ teamId, calendarId: cid })))
  }
  res.json({ data: { teamId, calendarIds: parsed.data.calendarIds }, error: null, meta: {} })
})
