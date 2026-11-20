import { db } from '../../db/index.js'
import { activities, oppReviewDismissals } from '../../../../drizzle/schema.js'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { dateWindow, productFilterCond, amountInRanges, type DashDateBasis, type AcvRange } from '../../routes/dashboards.js'

// vNext — "Closed Lost — Needs Review" (CLAUDE.md §7/§13, Manager group).
// Extracted out of the route handler so the candidate query is independently
// testable (mirrors mappingValidation.ts's validateOne() / writeback.ts's
// buildSfRecord() convention in this codebase). See the route's own comment
// in dashboards.ts for the full design writeup — this file is the query
// itself, the route just parses the request and calls it.

export interface ClosedLostReviewRow {
  oppId: string
  oppName: string
  accountName: string | null
  salesStage: string | null
  closeDate: string | null
  amount: string | null
  ownerName: string | null
  activityCount: number
  lastActivityAt: string
  dismissed: { by: string; at: string } | null
}

export interface FetchClosedLostReviewParams {
  teamId: string
  dateBasis: DashDateBasis
  rangeStart: Date
  rangeEnd: Date
  stages: string[]
  forecast: string[]
  acvRanges: AcvRange[]
  productIds: string[]
  memberIds: string[]
  includeDismissed: boolean
}

export async function fetchClosedLostReviewCandidates(params: FetchClosedLostReviewParams): Promise<ClosedLostReviewRow[]> {
  const { teamId, dateBasis, rangeStart, rangeEnd, stages, forecast, acvRanges, productIds, memberIds, includeDismissed } = params
  const productCond = productFilterCond(productIds)

  const rows = await db
    .select({
      oppId: activities.crmWhatId,
      oppName: sql<string>`max(${activities.crmWhatName})`,
      accountName: sql<string | null>`max(${activities.crmAccountName})`,
      salesStage: sql<string | null>`max(${activities.salesStage})`,
      closeDate: sql<string | null>`max(${activities.crmOppCloseDate})`,
      amount: sql<string | null>`max(${activities.oppAmount})`,
      maxAcv: sql<string | null>`max(${activities.acv})`,
      ownerName: sql<string | null>`max(${activities.crmOppOwnerName})`,
      activityCount: sql<number>`count(*)::int`,
      lastActivityAt: sql<string>`max(${activities.updatedAt})`,
    })
    .from(activities)
    .where(and(
      eq(activities.teamId, teamId),
      eq(activities.crmWhatType, 'Opportunity'),
      isNotNull(activities.crmWhatId),
      eq(activities.crmIsClosed, true),
      eq(activities.crmIsWon, false),
      eq(activities.isArchived, false),
      // CLAUDE.md §21: leader-dashboard reads never render draft data —
      // unlike the Relink action itself, which deliberately moves both
      // draft and submitted activities (a bulk data CORRECTION, not a
      // dashboard read).
      eq(activities.status, 'submitted'),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
      ...(stages.length > 0 ? [inArray(activities.salesStage, stages)] : []),
      ...(forecast.length > 0 ? [inArray(activities.forecastCategory, forecast)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))
    .groupBy(activities.crmWhatId)

  // ACV-range filter mirrors every other dashboard's own convention
  // (post-fetch amountInRanges() against the app's own ACV field, not the
  // raw SF Amount snapshot).
  const filtered = acvRanges.length > 0
    ? rows.filter((r) => amountInRanges(r.maxAcv != null ? Number(r.maxAcv) : null, acvRanges))
    : rows

  const oppIds = filtered.map((r) => r.oppId).filter((id): id is string => !!id)
  const dismissals = oppIds.length > 0
    ? await db.select().from(oppReviewDismissals)
        .where(and(eq(oppReviewDismissals.teamId, teamId), inArray(oppReviewDismissals.crmOppId, oppIds)))
    : []
  const dismissalByOppId = new Map(dismissals.map((d) => [d.crmOppId, d]))

  return filtered
    .filter((r) => includeDismissed || !dismissalByOppId.has(r.oppId!))
    .map((r) => {
      const dismissal = dismissalByOppId.get(r.oppId!)
      return {
        oppId: r.oppId!,
        oppName: r.oppName,
        accountName: r.accountName,
        salesStage: r.salesStage,
        closeDate: r.closeDate,
        amount: r.amount,
        ownerName: r.ownerName,
        activityCount: r.activityCount,
        lastActivityAt: r.lastActivityAt,
        dismissed: dismissal ? { by: dismissal.dismissedBy, at: dismissal.dismissedAt.toISOString() } : null,
      }
    })
    .sort((a, b) => b.activityCount - a.activityCount)
}
