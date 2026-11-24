// POST /api/v1/activities/log (v1.481.0): another tool logs an activity for a
// user it names by email, through an App Admin's activities:log key. The
// activity is always a DRAFT on that user's own list, never submitted: the
// person confirms it (and links the CRM record) in ImpactIQ like any other
// suggestion, and only then does write-back run. Contract in
// docs/activity-log-api.md.
import { z } from 'zod'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activityTypeTeams, teamActivityTypeSubtypes, teamActivityTypes, teamMembers, teams, users } from '../../../../drizzle/schema.js'
import { AttendeeSchema, LocationModeSchema } from '../../../shared/schemas/index.js'

const MAX_DURATION_MS = 24 * 60 * 60 * 1000

export const externalLogRequestSchema = z.object({
  ownerEmail: z.string().trim().toLowerCase().max(320).email(),
  // A type name on the person's team, matched without regard to case.
  activityType: z.string().trim().min(1).max(200).default('Demo'),
  // v1.482+: a Subtype of that type, by name in any case. Ignored when the
  // team has Subtypes off or no Subtype has that name (see result.subtype).
  subtype: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(500),
  startDatetime: z.string().datetime({ offset: true }),
  endDatetime: z.string().datetime({ offset: true }),
  // Defaults to the meeting's length.
  effortHours: z.number().min(0).max(24).optional(),
  notes: z.string().max(5000).optional(),
  locationMode: LocationModeSchema.optional(),
  attendees: z.array(AttendeeSchema).max(500).optional(),
  // The caller's own id for this activity, so a retry never logs it twice.
  externalRef: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/),
}).refine((b) => {
  const start = Date.parse(b.startDatetime)
  const end = Date.parse(b.endDatetime)
  return end > start && end - start <= MAX_DURATION_MS
}, { message: 'endDatetime must be after startDatetime and within 24 hours', path: ['endDatetime'] })

export type ExternalLogRequest = z.infer<typeof externalLogRequestSchema>

export interface ExternalLogResult {
  version: 1
  activityId: string
  status: 'draft' | 'submitted'
  deduped: boolean
  ownerEmail: string
  teamId: string
  teamName: string
  activityType: string
  /** The Subtype the activity got, or null (none asked for, Subtypes off, or no match). */
  subtype: string | null
  startDatetime: string
}

export type ExternalLogOutcome =
  | { ok: true; result: ExternalLogResult; created: boolean }
  | { ok: false; status: number; error: string }

/** The person, by email in any case. */
async function findOwner(email: string) {
  const [row] = await db
    .select({ id: users.id, email: users.email, disabledAt: users.disabledAt, defaultTeamId: users.defaultTeamId })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1)
  return row ?? null
}

/** The person's default team when they are a member of it, else their first active team (by name). */
async function pickTeam(userId: string, defaultTeamId: string | null) {
  const rows = await db
    .select({ id: teams.id, name: teams.name, subtypesEnabled: teams.subtypesEnabled })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), eq(teams.isActive, true)))
    .orderBy(asc(teams.name))
  return rows.find((t) => t.id === defaultTeamId) ?? rows[0] ?? null
}

/** An active type with this name that the team owns or shares. */
async function findType(teamId: string, name: string) {
  const [row] = await db
    .selectDistinct({ id: teamActivityTypes.id, name: teamActivityTypes.name })
    .from(teamActivityTypes)
    .leftJoin(activityTypeTeams, and(eq(activityTypeTeams.activityTypeId, teamActivityTypes.id), eq(activityTypeTeams.teamId, teamId)))
    .where(and(
      eq(teamActivityTypes.isActive, true),
      sql`lower(${teamActivityTypes.name}) = ${name.toLowerCase()}`,
      or(eq(teamActivityTypes.teamId, teamId), eq(activityTypeTeams.teamId, teamId)),
    ))
    .limit(1)
  return row ?? null
}

/** The type's Subtypes, in the order the admin set. */
async function subtypesOf(typeId: string) {
  return db
    .select({ id: teamActivityTypeSubtypes.id, name: teamActivityTypeSubtypes.name })
    .from(teamActivityTypeSubtypes)
    .where(eq(teamActivityTypeSubtypes.teamActivityTypeId, typeId))
    .orderBy(asc(teamActivityTypeSubtypes.sortOrder), asc(teamActivityTypeSubtypes.name))
}

async function existingByRef(ref: string) {
  const [row] = await db
    .select({
      id: activities.id,
      userId: activities.userId,
      status: activities.status,
      teamId: activities.teamId,
      startDatetime: activities.startDatetime,
      typeName: teamActivityTypes.name,
      subtypeName: activities.subtypeName,
      teamName: teams.name,
      ownerEmail: users.email,
    })
    .from(activities)
    .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .innerJoin(teams, eq(teams.id, activities.teamId))
    .innerJoin(users, eq(users.id, activities.userId))
    .where(eq(activities.externalRef, ref))
    .limit(1)
  return row ?? null
}

function asResult(row: NonNullable<Awaited<ReturnType<typeof existingByRef>>>, deduped: boolean): ExternalLogResult {
  return {
    version: 1,
    activityId: row.id,
    status: row.status,
    deduped,
    ownerEmail: row.ownerEmail.toLowerCase(),
    teamId: row.teamId,
    teamName: row.teamName,
    activityType: row.typeName,
    subtype: row.subtypeName,
    startDatetime: row.startDatetime.toISOString(),
  }
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err
  for (let i = 0; i < 3 && e && typeof e === 'object'; i++) {
    if ((e as { code?: unknown }).code === '23505') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

export async function logExternalActivity(body: ExternalLogRequest): Promise<ExternalLogOutcome> {
  const owner = await findOwner(body.ownerEmail)
  if (!owner) return { ok: false, status: 422, error: 'errors.activity_log.user_not_found' }

  // A retry of a call that already went through: hand back what it made,
  // unchanged (the person may already have edited or approved it).
  const prior = await existingByRef(body.externalRef)
  if (prior) {
    if (prior.userId !== owner.id) return { ok: false, status: 409, error: 'errors.activity_log.ref_in_use' }
    return { ok: true, result: asResult(prior, true), created: false }
  }

  if (owner.disabledAt) return { ok: false, status: 422, error: 'errors.activity_log.user_disabled' }
  const team = await pickTeam(owner.id, owner.defaultTeamId)
  if (!team) return { ok: false, status: 422, error: 'errors.activity_log.no_team' }
  const type = await findType(team.id, body.activityType)
  if (!type) return { ok: false, status: 422, error: 'errors.activity_log.type_not_found' }

  const start = new Date(body.startDatetime)
  const end = new Date(body.endDatetime)
  const hours = body.effortHours ?? Math.min(24, Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 100) / 100)

  const wanted = body.subtype?.toLowerCase()
  const subtype = wanted && team.subtypesEnabled
    ? (await subtypesOf(type.id)).find((st) => st.name.toLowerCase() === wanted) ?? null
    : null

  let created = true
  try {
    await db.insert(activities).values({
      userId: owner.id,
      teamId: team.id,
      title: body.title,
      activityTypeId: type.id,
      subtypeId: subtype?.id ?? null,
      subtypeName: subtype?.name ?? null,
      status: 'draft',
      startDatetime: start,
      endDatetime: end,
      effortHours: hours.toFixed(2),
      notes: body.notes ?? null,
      locationMode: body.locationMode ?? 'remote',
      attendees: body.attendees ?? null,
      externalRef: body.externalRef,
    })
  } catch (err) {
    // Two identical calls at once: the other one won, so this is a retry.
    if (!isUniqueViolation(err)) throw err
    created = false
  }
  const row = await existingByRef(body.externalRef)
  if (!row) throw new Error('activity insert returned no row')
  if (row.userId !== owner.id) return { ok: false, status: 409, error: 'errors.activity_log.ref_in_use' }
  return { ok: true, result: asResult(row, !created), created }
}


export const externalSubtypesQuerySchema = z.object({
  ownerEmail: z.string().trim().toLowerCase().max(320).email(),
  activityType: z.string().trim().min(1).max(200).default('Demo'),
})

export interface ExternalSubtypesResult {
  version: 1
  ownerEmail: string
  teamId: string
  teamName: string
  activityType: string
  /** False when the team has Subtypes turned off; `subtypes` is then empty. */
  subtypesEnabled: boolean
  subtypes: { id: string; name: string }[]
}

export type ExternalSubtypesOutcome =
  | { ok: true; result: ExternalSubtypesResult }
  | { ok: false; status: number; error: string }

/**
 * GET /api/v1/activities/subtypes (v1.482+): the Subtypes a call to
 * logExternalActivity would accept for this person and type, resolved the
 * same way (same team pick, same type match), so a caller can offer them
 * before it logs anything.
 */
export async function listExternalSubtypes(query: z.infer<typeof externalSubtypesQuerySchema>): Promise<ExternalSubtypesOutcome> {
  const owner = await findOwner(query.ownerEmail)
  if (!owner) return { ok: false, status: 422, error: 'errors.activity_log.user_not_found' }
  if (owner.disabledAt) return { ok: false, status: 422, error: 'errors.activity_log.user_disabled' }
  const team = await pickTeam(owner.id, owner.defaultTeamId)
  if (!team) return { ok: false, status: 422, error: 'errors.activity_log.no_team' }
  const type = await findType(team.id, query.activityType)
  if (!type) return { ok: false, status: 422, error: 'errors.activity_log.type_not_found' }
  return {
    ok: true,
    result: {
      version: 1,
      ownerEmail: owner.email.toLowerCase(),
      teamId: team.id,
      teamName: team.name,
      activityType: type.name,
      subtypesEnabled: team.subtypesEnabled,
      subtypes: team.subtypesEnabled ? await subtypesOf(type.id) : [],
    },
  }
}
