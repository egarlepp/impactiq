import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { addWeeks, format } from 'date-fns'
import { canonicalWeekStartFor, displayWeekStartFor } from '../../shared/weekNav.js'

export interface Activity {
  id: string
  title: string
  status: 'draft' | 'submitted'
  startDatetime: string
  endDatetime: string
  effortHours: string
  notes: string | null
  descriptionBody: string | null
  locationMode: 'remote' | 'onsite'
  meetingOwner: string | null
  // v1.319.0: kept separately from meetingOwner (name only) — two people can
  // share a display name across different orgs, so the email disambiguates
  // on hover. Never sent to Salesforce.
  meetingOwnerEmail: string | null
  attendees: { name?: string; email?: string }[] | null
  acv: string | null
  costTransportation?: string | null
  costLodging?: string | null
  costFood?: string | null
  incidentalCurrency?: string | null
  salesStage?: string | null
  forecastCategory?: string | null
  oppAmount?: string | null
  oppCloseDate?: string | null
  crmWhatId: string | null
  crmWhatType: 'Opportunity' | 'Account' | 'Campaign' | null
  crmWhatName: string | null
  crmAccountId?: string | null
  crmAccountName?: string | null
  crmAssignedSeName?: string | null
  crmWhoId: string | null
  crmWhoType: 'Contact' | 'Lead' | null
  crmWhoName: string | null
  crmRelatedType: string | null
  crmRelatedId: string | null
  crmRelatedName: string | null
  // v1.344.0: batch-computed by the nightly detect_disconnected_links job
  // (and self-healed by the drawer's own live check) — true when this
  // link's Salesforce record was requested but not found by a successful
  // query. Drives ActivityCard.tsx's "SF link broken" badge.
  crmWhatDeleted?: boolean
  crmWhoDeleted?: boolean
  crmRelatedDeleted?: boolean
  crmEvalStatus?: string | null
  crmEvalStage?: string | null
  crmEvalType?: string | null
  crmEvalStartDate?: string | null
  crmEvalEndDate?: string | null
  crmEvalPrimaryEngineer?: string | null
  crmRecordId: string | null
  crmSyncStatus: 'pending' | 'synced' | 'failed' | null
  crmSyncError: string | null
  crmSyncedAt: string | null
  // v1.156.0: Outlook calendar write-back status (per-user opt-in).
  outlookSyncStatus?: 'pending' | 'synced' | 'failed' | null
  outlookSyncError?: string | null
  outlookSyncedAt?: string | null
  activityTypeId: string
  activityTypeName: string
  activityTypeSfObject: 'Event' | 'Task'
  activityTypeColor: string | null
  activityTypeIcon: string | null
  // v1.256.0: optional Subtype selection under activityTypeId — see
  // teamActivityTypeSubtypes / ActivityForm.tsx's Subtype picker.
  subtypeId?: string | null
  subtypeName?: string | null
  meetingTypeReason?: string | null
  marketingEventName?: string | null
  // v1.262.0: approval-time snapshot of the Outlook event's own privacy
  // marking — drives the Private Meeting card treatment (masked title,
  // lock icon, pill). See CLAUDE.md §7 Private Meetings.
  isPrivateMeeting?: boolean
  outlookEventId?: string | null
  userId: string
  createdAt: string
  updatedAt: string
  // v1.241.0: when this activity was approved (draft -> submitted). Null for
  // drafts, and for approved rows created before the column existed only if
  // the migration's updated_at backfill also had nothing to go on.
  submittedAt?: string | null
  // v1.242.0: Keep was chosen for an activity whose Outlook meeting was
  // deleted — it exists in ImpactIQ + Salesforce but no longer on the
  // calendar. Renders a gray right border on the calendar block.
  outlookDeletedKept?: boolean
  // v1.363.0: non-null and outlookDeletedKept still false means this activity
  // is still awaiting that Keep/Delete decision — drives the red day-number
  // treatment on CalendarPanel's week header.
  outlookDeletedAt?: string | null
  products?: { id: string; name: string; abbreviation: string | null; iconDataUrl?: string | null }[]
  notesCount?: number
  // v1.342.0: count of attached Salesforce Support Tickets (§7) — drives the
  // approved-card right rail in ActivityCard.tsx. 0/undefined means none.
  ticketCount?: number
  // v1.460.0: count of linked Gong calls — drives the gray/colored
  // Transcripts icon next to the Notes icon in ActivityCard.tsx.
  gongCallCount?: number
}

// `weekStartsMonday` (default true) is the Activities page's Sun-first /
// Mon-first toggle. `weekStart` stays Monday-anchored either way; the toggle
// only decides which week offset 0 means on a Sunday: in Sunday-first mode a
// Sunday is displayed in the week that starts on it, so offset 0 is the
// Monday after (v1.456.1, see src/shared/weekNav.ts).
// v1.456.2: the fetch covers the 7 days the page DISPLAYS (Sunday to Saturday
// in Sunday-first mode), so a week's first Sunday shows its activities and the
// trailing Sunday (shown in the next week) isn't fetched and counted here.
export function useActivities(teamId: string | null, userId?: string | null, weekStartsMonday = true) {
  const [weekOffset, setWeekOffset] = useState(0)
  const [activities, setActivities] = useState<Activity[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const weekStart = addWeeks(canonicalWeekStartFor(new Date(), weekStartsMonday), weekOffset)

  const load = useCallback(async () => {
    // v1.321.0: never fetch without a resolved userId. WeeklyView's caller
    // passes `currentUser?.id`, which is briefly null while that hook is
    // still loading — omitting userId here previously fell through to the
    // server's no-userId branch (whole team, unfiltered by status), and a
    // slower earlier request racing a faster later one could let that
    // wrongly-broad response win and land in state, showing another team
    // member's activity as if it were the viewer's own. Every real caller of
    // this hook always wants a specific person's scope, so simply waiting
    // for userId (like the existing teamId guard) closes the race entirely.
    if (!teamId || !userId) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({
      teamId,
      weekStart: format(displayWeekStartFor(weekStart, weekStartsMonday), "yyyy-MM-dd'T'HH:mm:ssxxx"),
    })
    if (userId) params.set('userId', userId)
    const res = await api.get<Activity[]>(`/api/activities?${params.toString()}`)
    if (res.error) setError(res.error)
    else setActivities(res.data ?? [])
    setLoading(false)
  }, [teamId, weekOffset, userId, weekStartsMonday])

  useEffect(() => { load() }, [load])

  // Poll while any activity is still pending — the SF write-back is
  // fire-and-forget on the server, so without this the UI shows
  // "Syncing…" forever until the user hits refresh manually.
  // v1.159.0: also poll while an Outlook write-back is pending so the
  // "On Outlook" / "Outlook only" pills appear without a manual refresh.
  const hasPending = activities.some((a) => a.crmSyncStatus === 'pending' || a.outlookSyncStatus === 'pending')
  useEffect(() => {
    if (!hasPending) return
    const h = setInterval(() => { void load() }, 8000)
    return () => clearInterval(h)
  }, [hasPending, load])

  return { activities, loading, error, weekStart, weekOffset, setWeekOffset, reload: load }
}
