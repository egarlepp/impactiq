import type { Request } from 'express'
import { db } from '../../db/index.js'
import { auditEvents } from '../../../../drizzle/schema.js'
// v1.302.0: the action list moved to shared/auditActions.ts so the client's
// Audit Log filter dropdown can import the SAME array instead of a
// hand-maintained (and, by this version, badly out of date) subset — see
// that file for the full rationale.
import type { AuditAction } from '../../../shared/auditActions.js'

export type { AuditAction }

interface LogOpts {
  action: AuditAction
  targetType?: string | null
  targetId?: string | null
  meta?: Record<string, unknown> | null
  // For a route with no session middleware (an OAuth callback that checked
  // the session itself): who acted, when req.user isn't set.
  actor?: { id: string; email: string | null } | null
}

// Fire-and-forget audit write. Failures are logged but never throw — the
// business action must succeed or fail on its own merits, not because we
// couldn't write an audit row.
export async function logAudit(req: Request, opts: LogOpts): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      actorUserId: req.user?.id ?? opts.actor?.id ?? null,
      actorEmail: req.user?.email ?? opts.actor?.email ?? null,
      action: opts.action,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      meta: opts.meta ?? null,
      ip: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit] write failed:', err)
  }
}

// v1.333.0: same fire-and-forget insert as logAudit(), for the rare action
// that originates from a background job rather than an HTTP request (e.g.
// the restart-scheduler's own restart_triggered row) — there's no Request
// to pull actorUserId/ip/userAgent from, so those are always null. The
// Audit Log still shows the row; it just has no actor.
export async function logSystemAudit(opts: LogOpts): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      actorUserId: null,
      actorEmail: null,
      action: opts.action,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      meta: opts.meta ?? null,
      ip: null,
      userAgent: null,
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit] system write failed:', err)
  }
}
