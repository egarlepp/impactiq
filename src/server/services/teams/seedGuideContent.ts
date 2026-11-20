import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activityTypeTeams, teamActivityTypes, teamActivityTypeSubtypes, teams } from '../../../../drizzle/schema.js'
import { DEFAULT_GUIDE_CONTENT, defaultGuideDistinctions } from './defaultGuideContent.js'
import { DEFAULT_ACTIVITY_TYPE_STYLES } from '../../../shared/defaultActivityTypeStyles.js'
import { defaultTypeKey, evalWorkTypeName } from '../../../shared/terminology.js'
import { getTerminology } from '../config/terminology.js'

export interface SeedGuideContentResult {
  typesUpdated: number
  subtypesInserted: number
  distinctionsSet: boolean
}

// v1.255.4: the admin-triggered fallback for the SE example Guide content —
// see defaultGuideContent.ts's file comment for why this exists alongside
// migrations 0128/0129 rather than instead of them. Matches by activity
// type NAME on the given team (whatever its slug is), not a hardcoded team
// lookup. Every write is additive: useThisWhen/usuallyAttachTo/examples only
// fill currently-blank fields (never overwrite an admin's own edit),
// subtypes are only inserted for a type that currently has zero, and
// guideDistinctions is only set if blank. Shared by
// POST /api/admin/teams/:teamId/seed-guide-content and the Demo Data
// generator (v1.432.0).
export async function seedGuideContent(teamId: string): Promise<SeedGuideContentResult> {
  const rows = await db
    .select({ type: teamActivityTypes })
    .from(teamActivityTypes)
    .innerJoin(activityTypeTeams, and(
      eq(activityTypeTeams.activityTypeId, teamActivityTypes.id),
      eq(activityTypeTeams.teamId, teamId),
    ))

  // v1.446.0: the evaluation type is named from Admin → Workplace →
  // Terminology ("POx Work"); a kept "Eval Work" still matches its defaults.
  const evalWork = evalWorkTypeName(await getTerminology())
  let typesUpdated = 0
  let subtypesInserted = 0
  for (const { type } of rows) {
    const key = defaultTypeKey(type.name, evalWork)
    const patch: Record<string, string> = {}
    // v1.376.0: default icon + icon color, only where the type has none —
    // an admin's own pick is never overwritten.
    const style = DEFAULT_ACTIVITY_TYPE_STYLES[key]
    if (style) {
      if (!type.icon?.trim()) patch['icon'] = style.icon
      if (!type.color?.trim()) patch['color'] = style.color
    }
    const content = DEFAULT_GUIDE_CONTENT[key]
    if (!content) {
      if (Object.keys(patch).length > 0) {
        await db.update(teamActivityTypes).set(patch).where(eq(teamActivityTypes.id, type.id))
        typesUpdated++
      }
      continue
    }
    if (!type.useThisWhen?.trim()) patch['useThisWhen'] = content.useThisWhen
    if (!type.usuallyAttachTo?.trim()) patch['usuallyAttachTo'] = content.usuallyAttachTo
    if (!type.examples?.trim()) patch['examples'] = content.examples
    if (Object.keys(patch).length > 0) {
      await db.update(teamActivityTypes).set(patch).where(eq(teamActivityTypes.id, type.id))
      typesUpdated++
    }
    const [existingSubtype] = await db.select({ id: teamActivityTypeSubtypes.id }).from(teamActivityTypeSubtypes)
      .where(eq(teamActivityTypeSubtypes.teamActivityTypeId, type.id)).limit(1)
    if (!existingSubtype && content.subtypes.length > 0) {
      await db.insert(teamActivityTypeSubtypes).values(
        content.subtypes.map((name, i) => ({ teamActivityTypeId: type.id, name, sortOrder: (i + 1) * 10 })),
      )
      subtypesInserted += content.subtypes.length
    }
  }

  const [team] = await db.select({ guideDistinctions: teams.guideDistinctions }).from(teams).where(eq(teams.id, teamId)).limit(1)
  let distinctionsSet = false
  if (!team?.guideDistinctions?.trim()) {
    await db.update(teams).set({ guideDistinctions: defaultGuideDistinctions(evalWork) }).where(eq(teams.id, teamId))
    distinctionsSet = true
  }
  return { typesUpdated, subtypesInserted, distinctionsSet }
}
