import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { detachKeywordRulesFromTeam } from '../keywordRules/scope.js'
import {
  teams,
  teamActivityTypes,
  crmFieldMappings,
  sfEventTypeConfig,
  nudgeRules,
  capacityGroupTeams,
  capacityUserOverrides,
  costGroupTeams,
  costUserOverrides,
  teamMembers,
  activities,
  activityProducts,
  nudgeDismissals,
  attachRateFields,
  attachRateHistory,
  oppReviewDismissals,
  subteams,
  subteamUsers,
} from '../../../../drizzle/schema.js'

// Hard delete: purge child rows whose FKs are not ON DELETE CASCADE, in
// dependency order, then delete the team. Cascading FKs (junction tables,
// notifications, okta group mappings, team holiday calendars, product
// links, users.defaultTeamId→null) clear automatically on the final delete.
// Shared by DELETE /api/admin/teams/:teamId and the Demo Data remover.
export async function deleteTeamCascade(teamId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const activityIds = (await tx.select({ id: activities.id }).from(activities).where(eq(activities.teamId, teamId))).map((r) => r.id)
    if (activityIds.length > 0) {
      await tx.delete(activityProducts).where(inArray(activityProducts.activityId, activityIds))
    }
    await tx.delete(activities).where(eq(activities.teamId, teamId))

    const nudgeIds = (await tx.select({ id: nudgeRules.id }).from(nudgeRules).where(eq(nudgeRules.teamId, teamId))).map((r) => r.id)
    if (nudgeIds.length > 0) {
      await tx.delete(nudgeDismissals).where(inArray(nudgeDismissals.nudgeRuleId, nudgeIds))
    }
    await tx.delete(nudgeRules).where(eq(nudgeRules.teamId, teamId))

    // v1.468.0: a rule shared to other teams moves to one of them rather
    // than vanishing from them (see detachKeywordRulesFromTeam()).
    await detachKeywordRulesFromTeam(teamId, tx)
    await tx.delete(teamActivityTypes).where(eq(teamActivityTypes.teamId, teamId))

    // Detach any capacity / cost group attachments and any per-user
    // overrides tied to this team. Groups themselves are top-level now
    // and outlive team deletion.
    await tx.delete(capacityGroupTeams).where(eq(capacityGroupTeams.teamId, teamId))
    await tx.delete(capacityUserOverrides).where(eq(capacityUserOverrides.teamId, teamId))
    await tx.delete(costGroupTeams).where(eq(costGroupTeams.teamId, teamId))
    await tx.delete(costUserOverrides).where(eq(costUserOverrides.teamId, teamId))

    // Team-owned rows whose FK to teams is not ON DELETE CASCADE. Without
    // these a team with Attach Rate fields or a Closed Lost dismissal could
    // not be deleted at all.
    await tx.delete(attachRateFields).where(eq(attachRateFields.teamId, teamId))
    await tx.delete(attachRateHistory).where(eq(attachRateHistory.teamId, teamId))
    await tx.delete(oppReviewDismissals).where(eq(oppReviewDismissals.teamId, teamId))
    // subteam_users has no FK at all; subteams themselves cascade.
    const subteamIds = (await tx.select({ id: subteams.id }).from(subteams).where(eq(subteams.teamId, teamId))).map((r) => r.id)
    if (subteamIds.length > 0) {
      await tx.delete(subteamUsers).where(inArray(subteamUsers.subteamId, subteamIds))
    }

    await tx.delete(crmFieldMappings).where(eq(crmFieldMappings.teamId, teamId))
    await tx.delete(sfEventTypeConfig).where(eq(sfEventTypeConfig.teamId, teamId))
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId))
    await tx.delete(teams).where(eq(teams.id, teamId))
  })
}
