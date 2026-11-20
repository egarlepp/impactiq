// v1.475.0: first-run bootstrap for an install whose DATABASE_URL is set from
// the start (Docker Compose, any orchestrator). The /setup wizard only runs
// while DATABASE_URL is missing, so such an install used to come up with no
// users at all and no way to create one. While the users table is empty, the
// server prints the setup token at boot and the sign-in page offers a
// "Create the first admin" form that needs that token. The first account
// created closes the door for good: the check runs again under an advisory
// lock, so two requests racing each other can't both get through.
import { asc, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { teamMembers, teams, users } from '../../../../drizzle/schema.js'
import { hashPassword } from './password.js'
import { validatePasswordComplexity } from '../../../shared/schemas/password.js'

// Arbitrary constant: the advisory lock id for first-admin creation.
const FIRST_ADMIN_LOCK = 7_310_475_001

// Once a user exists the answer never changes back for this process, so the
// public status check stops touching the database after that.
let usersExist = false

export async function needsFirstAdmin(): Promise<boolean> {
  if (usersExist) return false
  const [row] = await db.select({ id: users.id }).from(users).limit(1)
  if (row) usersExist = true
  return !row
}

export function resetFirstRunCacheForTests(): void {
  usersExist = false
}

export interface FirstAdminInput {
  email: string
  displayName: string
  password: string
}

export type FirstAdminResult =
  | { ok: true; userId: string; teamId: string | null }
  | { ok: false; status: 400 | 409; error: string; detail?: string[] }

// Seeds the default team and content when the database has no team yet.
// Injected so tests can stand in for drizzle/seed.ts, which opens its own
// connection from DATABASE_URL.
export type SeedFn = () => Promise<void>

async function defaultSeed(): Promise<void> {
  const { runSeed } = await import('../../../../drizzle/seed.js')
  await runSeed()
}

export async function createFirstAdmin(input: FirstAdminInput, seed: SeedFn = defaultSeed): Promise<FirstAdminResult> {
  const email = input.email.trim().toLowerCase()
  const displayName = input.displayName.trim()
  if (!email || !displayName) return { ok: false, status: 400, error: 'errors.first_run.invalid_input' }
  const complexity = validatePasswordComplexity(input.password)
  if (!complexity.ok) return { ok: false, status: 400, error: 'errors.first_run.weak_password', detail: complexity.failedLabels }

  const passwordHash = hashPassword(input.password)
  if (!(await needsFirstAdmin())) return { ok: false, status: 409, error: 'errors.first_run.already_done' }

  // Seed the default team first, outside the transaction below (the seed
  // opens its own connection). Best effort, as in the setup wizard: an App
  // Admin sees every team without a team_members row, so a failed seed never
  // blocks the account. A second request racing this one fails the seed's
  // first insert (the team slug is unique) before writing anything.
  const [anyTeam] = await db.select({ id: teams.id }).from(teams).limit(1)
  if (!anyTeam) {
    try {
      await seed()
    } catch (err) {
      console.error('[first-run] Seeding the default team failed (the admin account is still created):', err)
    }
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`)
    const [existing] = await tx.select({ id: users.id }).from(users).limit(1)
    if (existing) {
      usersExist = true
      return { ok: false, status: 409, error: 'errors.first_run.already_done' } as const
    }
    const [team] = await tx.select({ id: teams.id }).from(teams).orderBy(asc(teams.createdAt)).limit(1)

    const [user] = await tx.insert(users).values({
      oktaId: `bootstrap:${email}`,
      email,
      displayName,
      passwordHash,
      passwordChangedAt: new Date(),
      isAppAdmin: true,
      canSeeAllTeams: true,
      // The first account owns the install: App Updates and similar controls
      // are limited to the default admin, and nobody else can grant it yet.
      isDefaultAdmin: true,
      defaultTeamId: team?.id ?? null,
    }).returning({ id: users.id })
    if (!user) throw new Error('first admin insert returned no row')

    if (team) {
      await tx.insert(teamMembers).values({ teamId: team.id, userId: user.id, role: 'admin' })
        .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { role: 'admin' } })
    }
    usersExist = true
    return { ok: true, userId: user.id, teamId: team?.id ?? null } as const
  })
}

