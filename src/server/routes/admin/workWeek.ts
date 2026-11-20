import { Router } from 'express'
import { db } from '../../db/index.js'
import { users } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { desc } from 'drizzle-orm'

export const workWeekRoutes = Router()

// ── Work-Week change request queue ──────────────────────────────────────────
// Contributors submit work-week edits from Settings; those go into
// `work_week_change_requests` as pending rows. An app admin approves or
// rejects them here. Admin edits via `PATCH /api/admin/users/:id/work-week`
// bypass the queue entirely — admin is the approver by definition.

workWeekRoutes.get('/work-week-requests', requireAppAdmin, async (req, res) => {
  const { workWeekChangeRequests } = await import('../../../../drizzle/schema.js')
  const status = String(req.query['status'] ?? 'pending')
  const rows = await db
    .select({
      id: workWeekChangeRequests.id,
      userId: workWeekChangeRequests.userId,
      requestedBy: workWeekChangeRequests.requestedBy,
      beforeSnapshot: workWeekChangeRequests.beforeSnapshot,
      afterSnapshot: workWeekChangeRequests.afterSnapshot,
      status: workWeekChangeRequests.status,
      createdAt: workWeekChangeRequests.createdAt,
      resolvedAt: workWeekChangeRequests.resolvedAt,
      notes: workWeekChangeRequests.notes,
      userDisplayName: users.displayName,
      userEmail: users.email,
    })
    .from(workWeekChangeRequests)
    .leftJoin(users, eq(users.id, workWeekChangeRequests.userId))
    .where(eq(workWeekChangeRequests.status, status))
    .orderBy(desc(workWeekChangeRequests.createdAt))
    .limit(200)
  res.json({ data: rows, error: null, meta: {} })
})

workWeekRoutes.post('/work-week-requests/:id/approve', requireAppAdmin, async (req, res) => {
  const { workWeekChangeRequests } = await import('../../../../drizzle/schema.js')
  const id = String(req.params['id'])
  const [row] = await db.select().from(workWeekChangeRequests).where(eq(workWeekChangeRequests.id, id)).limit(1)
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (row.status !== 'pending') { res.status(400).json({ data: null, error: 'errors.workweek.not_pending', meta: {} }); return }
  const after = row.afterSnapshot as { workerType: string; workDays: number; workDayStartHour: number; workDayEndHour: number; workHoursPerDay: unknown }
  await db.update(users).set({
    workerType: after.workerType,
    workDays: after.workDays,
    workDayStartHour: after.workDayStartHour,
    workDayEndHour: after.workDayEndHour,
    workHoursPerDay: after.workHoursPerDay ?? null,
    updatedAt: new Date(),
  }).where(eq(users.id, row.userId))
  await db.update(workWeekChangeRequests).set({ status: 'approved', resolvedAt: new Date(), resolvedBy: req.user!.id })
    .where(eq(workWeekChangeRequests.id, id))
  await logAudit(req, { action: 'work_week.approve', targetType: 'user', targetId: row.userId, meta: { before: row.beforeSnapshot, after: row.afterSnapshot } })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

workWeekRoutes.post('/work-week-requests/:id/reject', requireAppAdmin, async (req, res) => {
  const { workWeekChangeRequests } = await import('../../../../drizzle/schema.js')
  const id = String(req.params['id'])
  const notes = typeof req.body?.notes === 'string' ? String(req.body.notes).slice(0, 2000) : null
  const [row] = await db.select().from(workWeekChangeRequests).where(eq(workWeekChangeRequests.id, id)).limit(1)
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (row.status !== 'pending') { res.status(400).json({ data: null, error: 'errors.workweek.not_pending', meta: {} }); return }
  await db.update(workWeekChangeRequests).set({ status: 'rejected', resolvedAt: new Date(), resolvedBy: req.user!.id, notes })
    .where(eq(workWeekChangeRequests.id, id))
  await logAudit(req, { action: 'work_week.reject', targetType: 'user', targetId: row.userId, meta: { notes, after: row.afterSnapshot } })
  res.json({ data: { ok: true }, error: null, meta: {} })
})
