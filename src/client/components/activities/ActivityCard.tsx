import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useCrmApiBase, useCrmLabelContext } from '../../store/crmProvider.js'
import { format } from 'date-fns'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { formatTimeInTZ } from '../../lib/tz.js'
import { CheckCircle2, Clock, AlertCircle, AlertTriangle, RefreshCw, ExternalLink, MapPin, Wifi, ChevronDown, ChevronRight, Package, Briefcase, Building2, UserRound, NotebookPen, Megaphone, UserPlus, User, Link2, Link2Off, Target, CalendarCheck, CalendarX, MailX, Lock, Ticket, MessageCircleText } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'
import { Chip } from '../ui/chip.js'
import { Button } from '../ui/button.js'
import { SfActivitiesModal } from '../salesforce/SfActivitiesModal.js'
import { SfRecordPreview, type SfPreviewType, type ProjectSeed } from '../salesforce/SfRecordPreview.js'
import { NotesDrawer } from './NotesDrawer.js'
import type { Activity } from '../../hooks/useActivities.js'
import { api } from '../../lib/api.js'
import { formatRelativeTime } from '../../lib/time.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { useOpportunityAccounts } from '../../hooks/useOpportunityAccounts.js'
import { evalTypeIcon } from '../../lib/sf-icons.js'
import { useTeam } from '../../hooks/useTeam.js'
import { formatCurrency } from '../../lib/displayCurrency.js'
import { useProjectsEnabled } from '../../store/evaluationSource.js'
import { isCriteriaIqProjectLink } from '../../../shared/evaluationSource.js'

interface ActivityCardProps {
  activity: Activity
  teamId: string
  // v1.460.0: the optional tab opens the drawer on that tab (the
  // Transcripts icon opens it on Transcripts).
  onEdit: (activity: Activity, tab?: 'transcripts') => void
  onReload: () => void
  compact?: boolean
  // v1.241.0: the viewer's own RSVP on the Outlook meeting this activity came
  // from is Tentative. Resolved by the parent against the live calendar
  // events (see WeeklyView) rather than persisted on the activity, so it
  // reflects an RSVP change after approval instead of freezing at the value
  // it had when the activity was created.
  isTentative?: boolean
  // v1.460.0: show the Transcripts icon next to the Notes icon (Gong ready for
  // this team and the viewer has the Transcripts tab).
  transcriptsEnabled?: boolean
  // v1.262.0: team's configured Non-Activity anchor color (from
  // useSuggestions()'s meta.nonActivityColor), reused as the Private
  // Meeting card background when set. Falls back to plain light gray
  // client-side when null. See CLAUDE.md §7 Private Meetings.
  nonActivityColor?: string | null
  // v1.321.0: backfilled email for the hover tooltip on legacy activities
  // approved before v1.319.0 added activities.meetingOwnerEmail — resolved
  // by the parent against the live calendar event (see WeeklyView), only
  // when that event's organizer name matches the stored meeting owner.
  meetingOwnerEmailOverride?: string | null
}

export function ActivityCard({ activity, teamId, onEdit, onReload, compact = false, isTentative = false, nonActivityColor = null, meetingOwnerEmailOverride = null, transcriptsEnabled = false }: ActivityCardProps) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [sfModalOpen, setSfModalOpen] = useState(false)
  const [acctModal, setAcctModal] = useState<{ id: string; name: string } | null>(null)
  const [relatedModalOpen, setRelatedModalOpen] = useState(false)
  // v1.387.0: with Projects off, the Project chip and its drill-in are hidden.
  const projectsOn = useProjectsEnabled()
  // v1.74.0: track the resolved Display Label for the SF Related chip
  // so we can pass it into the modal header instead of the raw
  // "Related" whatType tag.
  const [relatedLabel, setRelatedLabel] = useState<string>('Related')
  const [attendeesOpen, setAttendeesOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  // Individual expand override — only meaningful in compact mode. Clicking
  // the chevron on the far right of the Started/Ended row toggles this so
  // one card can be examined without turning the whole page back to full.
  const [individuallyExpanded, setIndividuallyExpanded] = useState(false)
  // Compact only applies to already-approved cards; drafts always show the
  // full detail so the user sees what they haven't submitted yet.
  const compactActive = compact && activity.status === 'submitted' && !individuallyExpanded

  async function handleRetrySync() {
    await api.patch(`/api/activities/${activity.id}`, { crmSyncStatus: 'pending' })
    onReload()
  }

  const { user } = useCurrentUser()
  const tz = user?.timezone ?? null
  const startTime = formatTimeInTZ(activity.startDatetime, tz)
  const endTime = formatTimeInTZ(activity.endDatetime, tz)
  const durationH = Number(activity.effortHours).toFixed(1)
  const typeColor = activity.activityTypeColor ?? null
  // v1.262.0: Private Meeting treatment overrides the normal per-type tint —
  // background matches the team's Non-Activity anchor color (same convention
  // as the Suggested card) with a plain light-gray fallback when that isn't
  // configured. See CLAUDE.md §7 Private Meetings.
  const isPrivate = !!activity.isPrivateMeeting

  // v1.369.0: still-pending "Outlook meeting deleted" review (§10) — the
  // "This Week's Deleted Activities" section above already carries its own
  // card for this, but the SAME activity's title in the ordinary day list
  // gave no visual signal there was anything to decide. Mirrors the flag
  // v1.363.0 already reads for the month-heatmap/week-header dots: non-null
  // outlookDeletedAt and outlookDeletedKept still false. Never true at the
  // same time as outlookDeletedKept (Keep clears the "pending" half of this
  // by design — see the outlookDeletedKept badge below).
  const isOutlookDeletionPending = !!activity.outlookDeletedAt && !activity.outlookDeletedKept
  const tintStyle = isPrivate && nonActivityColor
    ? { backgroundColor: `${nonActivityColor}26`, borderLeft: `3px solid ${nonActivityColor}` }
    : isPrivate
    ? undefined
    : typeColor
    ? { backgroundColor: `${typeColor}14`, borderLeft: `3px solid ${typeColor}` }
    : undefined

  // Onsite incidental (Direct) costs — captured in the currency the user had
  // active when they entered them (incidentalCurrency), not converted here.
  // The pin only turns orange when there's actually a cost to flag; a plain
  // onsite activity with nothing entered stays neutral gray.
  // v1.342.0: attached Support Tickets (§7) get a flush right rail — see the
  // render below. Only on approved cards, mirroring the left type-color bar's
  // own submitted-vs-draft convention (a draft's tickets aren't final yet).
  const ticketCount = activity.ticketCount ?? 0
  const hasTickets = activity.status === 'submitted' && ticketCount > 0

  const incidentalTotal =
    (Number(activity.costTransportation) || 0) + (Number(activity.costLodging) || 0) + (Number(activity.costFood) || 0)
  const hasIncidentalCosts = activity.locationMode === 'onsite' && incidentalTotal > 0
  const onsiteTooltip = hasIncidentalCosts
    ? t('activity.location.onsite_with_cost', { amount: formatCurrency(incidentalTotal, activity.incidentalCurrency || 'USD') })
    : t('activity.location.onsite')

  return (
    <div
      className={cn(
        'relative flex cursor-pointer flex-col gap-1 overflow-hidden rounded-md border p-3 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50',
        isPrivate && !nonActivityColor
          ? 'border-gray-300 bg-gray-100 dark:border-gray-600 dark:bg-gray-800/60'
          : typeColor
          ? 'border-gray-200 dark:border-gray-700'
          : activity.status === 'draft'
          ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'
          : 'border-green-200 bg-green-50/30 dark:border-green-800 dark:bg-green-950/20',
        // v1.241.0: tentative RSVP. background-IMAGE only, so the per-type
        // tint + left approval bar (tintStyle) both stay intact underneath.
        isTentative && 'stripe-tentative',
        // v1.342.0: room for the flush ticket rail below so it doesn't sit
        // on top of the checkmark/sync-status row already hugging the right
        // edge.
        hasTickets && 'pr-6',
      )}
      style={tintStyle}
      // Ignore card-level clicks while the Notes drawer is open — the
      // Dialog's backdrop closes the drawer on outside-click and a
      // stray propagation can then land on this card and open the
      // Edit drawer underneath. If the notes drawer is up, treat any
      // card click as a "just close the drawer" gesture.
      onClick={() => { if (!notesOpen) onEdit(activity) }}
    >
      {/* v1.262.0: large transparent watermark — purely decorative, sits
          behind the content in normal flow and never intercepts clicks. */}
      {isPrivate && (
        <Lock className="pointer-events-none absolute -bottom-3 -right-3 h-28 w-28 text-gray-400 opacity-20 dark:text-gray-300" aria-hidden="true" />
      )}
      {/* v1.342.0: flush right rail flagging attached Support Tickets (§7) —
          full card height, no gaps, same convention as the left type-color
          bar but on the opposite edge so the two never compete for space. */}
      {hasTickets && (
        <span
          className="absolute inset-y-0 right-0 flex w-5 items-center justify-center bg-red-500 dark:bg-red-600"
          title={t('activity.tickets_attached_hint', { count: ticketCount, context: crmCtx, defaultValue: '{{count}} Salesforce ticket(s) attached' })}
          aria-label={t('activity.tickets_attached_hint', { count: ticketCount, context: crmCtx, defaultValue: '{{count}} Salesforce ticket(s) attached' })}
        >
          <Ticket className="h-3.5 w-3.5 text-white" />
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <span className="flex flex-1 items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
          {isPrivate ? (
            <Lock className="h-4 w-4 shrink-0" />
          ) : activity.activityTypeIcon ? (
            <DynamicIcon
              name={activity.activityTypeIcon}
              className="h-4 w-4 shrink-0"
              {...(typeColor ? { style: { color: typeColor } } : {})}
            />
          ) : null}
          <span
            className={cn('line-clamp-2', isOutlookDeletionPending && 'text-red-600 dark:text-red-400')}
            title={isOutlookDeletionPending ? t('activity.outlook_deleted.title_hint', 'The Outlook meeting for this activity was deleted — review it above') : undefined}
          >
            {isPrivate ? t('activity.private_meeting.title', 'Private meeting') : activity.title}
          </span>
          {/* Notes affordance sits right next to the activity title — gray
              when this activity has no notes, blue with a count when it does. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setNotesOpen((v) => !v) }}
            title={(activity.notesCount ?? 0) > 0
              ? t('activity.notes.open_with_count', { count: activity.notesCount, defaultValue: '{{count}} note(s) — click to open' })
              : t('activity.notes.open_empty', 'Add notes')}
            className={cn(
              'ml-1 inline-flex cursor-pointer items-center gap-0.5 rounded p-0.5 hover:bg-gray-100 dark:hover:bg-gray-800',
              (activity.notesCount ?? 0) > 0
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-400 dark:text-gray-500',
            )}
            aria-label={t('activity.notes.open_notes', 'Open notes')}
          >
            <NotebookPen className="h-3.5 w-3.5" />
            {(activity.notesCount ?? 0) > 0 && (
              <span className="text-[10px] font-semibold leading-none">{activity.notesCount}</span>
            )}
          </button>
          {/* v1.460.0: Transcripts affordance, right of Notes — gray when no
              Gong call is linked, blue with a count when one is. Opens the
              drawer on the Transcripts tab. */}
          {transcriptsEnabled && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEdit(activity, 'transcripts') }}
              title={(activity.gongCallCount ?? 0) > 0
                ? t('activity.gong.transcripts_icon', { count: activity.gongCallCount })
                : t('activity.gong.transcripts_icon_empty')}
              className={cn(
                'inline-flex cursor-pointer items-center gap-0.5 rounded p-0.5 hover:bg-gray-100 dark:hover:bg-gray-800',
                (activity.gongCallCount ?? 0) > 0
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-400 dark:text-gray-500',
              )}
              aria-label={t('activity.gong.transcripts_icon_aria')}
            >
              <MessageCircleText className="h-3.5 w-3.5" />
              {(activity.gongCallCount ?? 0) > 0 && (
                <span className="text-[10px] font-semibold leading-none">{activity.gongCallCount}</span>
              )}
            </button>
          )}
          {activity.crmRecordId && user?.sfInstanceUrl && (
            <a
              href={`${user.sfInstanceUrl.replace(/\/$/, '')}/lightning/r/${activity.activityTypeSfObject}/${activity.crmRecordId}/view`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={t('activity.sf_link.open')}
              aria-label={t('activity.sf_link.aria')}
              className="ml-1 inline-flex items-center rounded p-0.5 text-blue-600 hover:bg-gray-100 dark:text-blue-400 dark:hover:bg-gray-800"
            >
              <Link2 className="h-3.5 w-3.5" />
            </a>
          )}
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
          {activity.crmWhatType === 'Opportunity' && activity.acv != null && (
            <span
              className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-xs font-bold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
              title={t('activity.acv_hint')}
            >
              ${Number(activity.acv).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          )}
          {activity.locationMode === 'onsite' ? (
            <span title={onsiteTooltip}>
              <MapPin className={cn('h-4 w-4', hasIncidentalCosts ? 'text-orange-600 dark:text-orange-400' : 'text-gray-400 dark:text-gray-500')} />
            </span>
          ) : (
            <span title={t('activity.location.remote')}><Wifi className="h-4 w-4 text-blue-600 dark:text-blue-400" /></span>
          )}
          {activity.status === 'submitted' ? (
            // v1.241.0: the check alone never said what it meant, let alone
            // when. submittedAt is the approval date specifically — not
            // updatedAt, which any later edit moves.
            <span
              title={activity.submittedAt
                ? t('activity.approved.on', { date: new Date(activity.submittedAt).toLocaleString() })
                : t('activity.approved.no_date')}
            >
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
            </span>
          ) : (
            <span title={t('common.status.draft')}>
              <Clock className="h-4 w-4 text-gray-400" />
            </span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* TODO(chip): activity type badge uses dynamic per-type color from DB — Chip doesn't yet
            support arbitrary background overrides. Leaving as Badge for now. */}
        <Badge
          variant="secondary"
          style={typeColor ? { backgroundColor: typeColor, color: '#fff', borderColor: typeColor } : undefined}
          title={activity.subtypeName ?? undefined}
        >
          {activity.activityTypeName}
        </Badge>
        {isPrivate && (
          <Badge
            variant="outline"
            className="gap-1"
            title={t('activity.private_meeting.pill_hint', "This meeting is marked Private/Confidential in Outlook — it's shown here as Private meeting.")}
          >
            <Lock className="h-3 w-3" />
            {t('activity.private_meeting.pill', 'Private')}
          </Badge>
        )}
        {activity.status === 'draft' && (
          <Chip variant="neutral" size="xs">{t('common.status.draft')}</Chip>
        )}
        {activity.crmWhatName && activity.crmWhatId && activity.crmWhatType && (
          <SfLink
            activity={activity}
            onOpen={() => setSfModalOpen(true)}
            onOpenAccount={(id, name) => setAcctModal({ id, name })}
          />
        )}
        {/* v1.68.0 / v1.72.0: clickable SF Related chip (Evaluation__c
            and future child-object pickers). Uses the admin-configured
            Display Label from the activity type's SF Extras row when
            present (e.g. "Evaluations"), falls back to a humanized
            sobject API name otherwise. Icon: Target. Clicking opens
            the SF Activities modal filtered by relatedId. */}
        {projectsOn && activity.crmRelatedId && activity.crmRelatedName && (
          <SfRelatedChip
            activityTypeId={activity.activityTypeId}
            crmRelatedId={activity.crmRelatedId}
            crmRelatedType={activity.crmRelatedType}
            crmRelatedName={activity.crmRelatedName}
            crmEvalType={activity.crmEvalType}
            evalSeed={{
              status: activity.crmEvalStatus,
              stage: activity.crmEvalStage,
              evalType: activity.crmEvalType,
              startDate: activity.crmEvalStartDate,
              endDate: activity.crmEvalEndDate,
              primaryEngineer: activity.crmEvalPrimaryEngineer,
            }}
            onOpen={() => setRelatedModalOpen(true)}
            onLabelResolved={setRelatedLabel}
          />
        )}
        {activity.crmWhoName && activity.crmWhoId && activity.crmWhoType && (
          // Match the What-side row: icon + label + name. Previously
          // rendered as just a text badge (CON/LEAD), which didn't
          // read as an SF link at a glance.
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" title={`${activity.crmWhoType}: ${activity.crmWhoName}`}>
            <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
              {activity.crmWhoType === 'Lead'
                ? <UserPlus className="h-3 w-3 shrink-0" />
                : <User className="h-3 w-3 shrink-0" />}
              {activity.crmWhoType === 'Lead'
                ? t('activity.sf.lead_label', 'Lead')
                : t('activity.sf.contact_label', 'Contact')}:
            </span>
            <span className="max-w-[180px] truncate text-gray-700 dark:text-gray-200">{activity.crmWhoName}</span>
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
          <Clock className="h-3 w-3 shrink-0" />
          {t('activity.started')}: {startTime} · {t('activity.ended')}: {endTime} · {durationH}h
        </span>
        <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-500" title={new Date(activity.createdAt).toLocaleString()}>
          {t('activity.date_created')}: {format(new Date(activity.createdAt), 'MMM d, yyyy')}
        </span>
        {/* v1.159.0: a submitted activity with no Salesforce linkage lives only
            in ImpactIQ / Outlook, never Salesforce — flag it. Keyed on the
            absence of any SF What/Who link (not on Outlook write-back), so it
            shows the moment the activity is approved. */}
        {activity.status === 'submitted' && !activity.crmWhatId && !activity.crmWhoId && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
            title={t('activity.outlook_only.hint', { context: crmCtx, defaultValue: 'This activity isn’t linked to Salesforce.' })}
          >
            <AlertTriangle className="h-3 w-3" />
            {t('activity.outlook_only.label', 'Outlook only')}
          </span>
        )}

        {/* v1.242.0: the inverse of "Outlook only" — this one IS in Salesforce
            but no longer on the calendar, because the meeting was deleted and
            the user chose Keep. The two are mutually exclusive by definition
            (one requires no SF link, the other requires the activity to have
            been approved and synced), so they never appear together. */}
        {activity.outlookDeletedKept && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-orange-400 bg-orange-50 px-2 py-0.5 text-[10px] font-medium text-orange-700 dark:border-orange-600 dark:bg-orange-950/40 dark:text-orange-400"
            title={t('activity.outlook_deleted.kept_hint', { context: crmCtx })}
          >
            <MailX className="h-3 w-3" />
            {t('activity.outlook_deleted.badge')}
          </span>
        )}

        {/* v1.344.0: batch-driven from the nightly detect_disconnected_links
            job (CLAUDE.md §7/§11) — a link that WAS connected to Salesforce
            but no longer resolves there (most likely because the record was
            deleted). Distinct rose color/Link2Off icon so this never reads
            as either "Outlook only" (never linked, above) or "Not In
            Outlook" (orange, above) — all three mean different things.
            Shown on both draft and submitted cards, unlike the leader
            dashboard (submitted-only) — surfacing the problem before the
            owner even submits is more useful here. */}
        {(activity.crmWhatDeleted || activity.crmWhoDeleted || activity.crmRelatedDeleted) && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
            title={t('activity.sf_disconnected.hint', { defaultValue: 'One or more linked Salesforce records could not be found — open this activity to see which.', context: crmCtx })}
          >
            <Link2Off className="h-3 w-3" />
            {t('activity.sf_disconnected.badge', { defaultValue: 'SF link broken', context: crmCtx })}
          </span>
        )}

        {activity.crmSyncStatus === 'failed' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-red-600 dark:text-red-400"
            onClick={(e) => { e.stopPropagation(); handleRetrySync() }}
            title={activity.crmSyncError ?? t('activity.sync.retry_hint', { context: crmCtx })}
          >
            <AlertCircle className="h-3 w-3 mr-1" />
            {t('activity.sync.retry')}
          </Button>
        )}
        {activity.crmSyncStatus === 'pending' && (
          <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {t('activity.sync.pending', { context: crmCtx })}
          </span>
        )}
        {activity.crmSyncStatus === 'synced' && (
          <span
            className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"
            title={activity.crmSyncedAt ? new Date(activity.crmSyncedAt).toLocaleString() : undefined}
          >
            <CheckCircle2 className="h-3 w-3" />
            {activity.crmSyncedAt
              ? t('activity.sync.synced_ago', { when: formatRelativeTime(activity.crmSyncedAt, t) })
              : t('activity.sync.synced', { context: crmCtx })}
          </span>
        )}
        {/* v1.156.0: Outlook calendar write-back status (only shown when set). */}
        {activity.outlookSyncStatus === 'synced' && (
          <span
            className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400"
            title={activity.outlookSyncedAt ? new Date(activity.outlookSyncedAt).toLocaleString() : undefined}
          >
            <CalendarCheck className="h-3 w-3" />
            {t('activity.outlook_sync.synced', 'On Outlook')}
          </span>
        )}
        {activity.outlookSyncStatus === 'failed' && (
          <span
            className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
            title={activity.outlookSyncError ?? undefined}
          >
            <CalendarX className="h-3 w-3" />
            {t('activity.outlook_sync.failed', 'Outlook sync failed')}
          </span>
        )}
        {compact && activity.status === 'submitted' && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setIndividuallyExpanded((v) => !v) }}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={individuallyExpanded ? t('activity.compact_collapse_one', 'Collapse this activity') : t('activity.compact_expand_one', 'Expand this activity')}
            title={individuallyExpanded ? t('activity.compact_collapse_one', 'Collapse this activity') : t('activity.compact_expand_one', 'Expand this activity')}
          >
            {individuallyExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {!compactActive && activity.status === 'submitted' && activity.products && activity.products.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <Package className="h-3 w-3 shrink-0 text-gray-500 dark:text-gray-400" />
          <span className="text-gray-500 dark:text-gray-400">{t('activity.products_label')}:</span>
          {/* v1.93.0: pills with the product's uploaded icon left of the
              name; fall back to a text-only pill when no icon is set. */}
          {activity.products.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
              {p.iconDataUrl && <img src={p.iconDataUrl} alt="" className="h-3 w-3 shrink-0 rounded-sm object-contain" />}
              <span>{p.name}</span>
            </span>
          ))}
        </div>
      )}

      {!compactActive && activity.meetingOwner && (
        <div className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          <UserRound className="h-3 w-3 shrink-0 text-gray-500 dark:text-gray-400" />
          <span className="text-gray-500 dark:text-gray-400">{t('activity.meeting_owner')}:</span>{' '}
          {/* v1.319.0: hover reveals the organizer's email — two people can share a display name across different orgs. */}
          <span title={(activity.meetingOwnerEmail ?? meetingOwnerEmailOverride) ?? undefined}>{activity.meetingOwner}</span>
        </div>
      )}
      {!compactActive && activity.crmWhatType === 'Opportunity' && activity.crmWhatId && (
        <AssignedSeLine
          oppId={activity.crmWhatId}
          teamId={teamId}
          activityId={activity.id}
          refetchKey={activity.updatedAt}
          cachedName={activity.crmAssignedSeName ?? null}
        />
      )}
      {!compactActive && activity.attendees && activity.attendees.length > 0 && (
        <div className="text-xs">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setAttendeesOpen((v) => !v) }}
            className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
          >
            {attendeesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {t('activity.attendees_label', { count: activity.attendees.length })}
          </button>
          {attendeesOpen && (
            <div className="mt-1 whitespace-pre-wrap break-words rounded-md bg-gray-50 px-2 py-1 text-[11px] text-gray-700 dark:bg-gray-800/60 dark:text-gray-200">
              {activity.attendees.map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : a.name ?? a.email ?? '')).join('; ')}
            </div>
          )}
        </div>
      )}

      {activity.crmWhatId && (activity.crmWhatType === 'Opportunity' || activity.crmWhatType === 'Account') && activity.crmWhatName && (
        <SfActivitiesModal
          open={sfModalOpen}
          onClose={() => setSfModalOpen(false)}
          teamId={teamId}
          whatId={activity.crmWhatId}
          whatType={activity.crmWhatType}
          whatName={activity.crmWhatName}
        />
      )}
      {acctModal && (
        <SfActivitiesModal
          open={!!acctModal}
          onClose={() => setAcctModal(null)}
          teamId={teamId}
          whatId={acctModal.id}
          whatType="Account"
          whatName={acctModal.name}
        />
      )}
      {projectsOn && activity.crmRelatedId && activity.crmRelatedName && (
        <SfActivitiesModal
          open={relatedModalOpen}
          onClose={() => setRelatedModalOpen(false)}
          teamId={teamId}
          whatId={activity.crmRelatedId}
          whatType="Related"
          whatName={activity.crmRelatedName}
          whatTypeLabel={relatedLabel}
          relatedId={activity.crmRelatedId}
          relatedType={activity.crmRelatedType}
        />
      )}
      <NotesDrawer
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        activityId={activity.id}
        teamId={teamId}
        activityTitle={isPrivate ? t('activity.private_meeting.title', 'Private meeting') : activity.title}
        activityTypeIcon={activity.activityTypeIcon}
        activityTypeColor={activity.activityTypeColor}
        crmWhatId={activity.crmWhatId}
        crmWhatType={activity.crmWhatType}
        crmWhatName={activity.crmWhatName}
        crmWhoId={activity.crmWhoId}
        crmWhoType={activity.crmWhoType}
        crmWhoName={activity.crmWhoName}
        activityTypeName={activity.activityTypeName}
        crmRelatedType={activity.crmRelatedType}
        crmRelatedId={activity.crmRelatedId}
        crmAccountId={activity.crmAccountId}
        crmAccountName={activity.crmAccountName}
        onReload={onReload}
      />
    </div>
  )
}

function SfLink({
  activity,
  onOpen,
  onOpenAccount,
}: {
  activity: Activity
  onOpen: () => void
  onOpenAccount: (accountId: string, accountName: string) => void
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const isOpp = activity.crmWhatType === 'Opportunity'
  const isCampaign = activity.crmWhatType === 'Campaign'
  // v1.97.0: prefer the persisted Account snapshot (written by the form)
  // over a live SF read. The live fetch stays as a fallback so cards
  // saved before v1.97 still resolve their Account.
  // v1.119.0: also fetch when accountName is cached but accountId is
  // null — otherwise the card renders the Account as plain text
  // forever. Applies to every activity approved before v1.117 wired
  // AccountId through the save payload.
  const hasCachedAcctName = !!activity.crmAccountName
  const hasCachedAcctId = !!activity.crmAccountId
  const oppIds = isOpp && activity.crmWhatId && !hasCachedAcctId ? [activity.crmWhatId] : []
  const accounts = useOpportunityAccounts(oppIds)
  const fetchedAcct = isOpp && activity.crmWhatId ? accounts.get(activity.crmWhatId) : undefined
  const acct = isOpp
    ? (hasCachedAcctName || fetchedAcct?.accountName
        ? { id: activity.crmWhatId!, accountId: activity.crmAccountId ?? fetchedAcct?.accountId ?? null, accountName: activity.crmAccountName ?? fetchedAcct?.accountName ?? null }
        : undefined)
    : undefined
  // v1.98.0 + v1.119.0: lazy backfill — persist any newly-resolved
  // accountId (and name) onto the activity so subsequent reads
  // render the clickable link without another SF round-trip. Fires
  // whenever the live fetch produced a value we don't already have.
  useEffect(() => {
    if (!isOpp || !activity.id) return
    if (!fetchedAcct?.accountId && !fetchedAcct?.accountName) return
    const needsIdBackfill = !activity.crmAccountId && !!fetchedAcct?.accountId
    const needsNameBackfill = !activity.crmAccountName && !!fetchedAcct?.accountName
    if (!needsIdBackfill && !needsNameBackfill) return
    void api.patch(`/api/activities/${activity.id}`, {
      crmAccountId: activity.crmAccountId ?? fetchedAcct.accountId ?? null,
      crmAccountName: activity.crmAccountName ?? fetchedAcct.accountName ?? null,
    }).catch(() => { /* ignore */ })
  }, [isOpp, activity.id, activity.crmAccountId, activity.crmAccountName, fetchedAcct?.accountId, fetchedAcct?.accountName])
  const label = isOpp
    ? t('activity.sf.opportunity_label', { context: crmCtx })
    : isCampaign
    ? t('activity.sf.campaign_label', { context: crmCtx })
    : t('activity.sf.account_label', { context: crmCtx })
  // v1.74.2: order Account → Opportunity, per SE feedback. The
  // resolved Account (via useOpportunityAccounts) reads first, then
  // the Opportunity name. Non-Opp What links (Account, Campaign)
  // render on their own since there's no Account to lead with.
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {isOpp && !acct?.accountName && (
        // v1.100.0: SF isn't connected or the Account read hasn't
        // resolved yet — show a placeholder so the Account column
        // doesn't silently drop, per SE feedback that the Account line
        // just disappears when SF is unreachable.
        <>
          <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
            <Building2 className="h-3 w-3 shrink-0" />
            {t('activity.sf.account_label')}:
          </span>
          <span className="italic text-gray-400 dark:text-gray-500" title={t('activity.sf.account_not_synced_hint', { context: crmCtx })}>
            {t('activity.sf.not_synced', 'Not synced')}
          </span>
        </>
      )}
      {isOpp && acct?.accountName && (
        <>
          <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
            <Building2 className="h-3 w-3 shrink-0" />
            {t('activity.sf.account_label')}:
          </span>
          {acct.accountId ? (
            <SfRecordPreview type="Account" id={acct.accountId} fallbackName={acct.accountName}>
              <button
                onClick={(e) => { e.stopPropagation(); onOpenAccount(acct.accountId!, acct.accountName!) }}
                className="inline-flex max-w-[180px] items-center gap-1 truncate text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                title={acct.accountName}
              >
                <span className="truncate">{acct.accountName}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </button>
            </SfRecordPreview>
          ) : (
            <span className="inline-flex max-w-[180px] items-center gap-1 truncate text-gray-700 dark:text-gray-300" title={acct.accountName}>
              <span className="truncate">{acct.accountName}</span>
            </span>
          )}
        </>
      )}
      <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
        {isOpp
          ? <Briefcase className="h-3 w-3 shrink-0" />
          : isCampaign
          ? <Megaphone className="h-3 w-3 shrink-0" />
          : <Building2 className="h-3 w-3 shrink-0" />}
        {label}:
      </span>
      {/* v1.218.0: hover preview on the What link. Only Opportunity and
          Account have a preview shape — a Campaign renders the bare button,
          same as before. */}
      <MaybePreview
        type={isOpp ? 'Opportunity' : activity.crmWhatType === 'Account' ? 'Account' : null}
        id={activity.crmWhatId}
        name={activity.crmWhatName}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onOpen() }}
          className="group inline-flex max-w-[180px] items-center gap-1 truncate text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
          title={t('sf_activities.view_for', { name: activity.crmWhatName ?? '' })}
        >
          <span className="truncate">{activity.crmWhatName}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      </MaybePreview>
    </span>
  )
}

// Wraps children in a preview popover only when there's a previewable SF
// record behind them, so the caller doesn't have to branch its JSX.
function MaybePreview({
  type,
  id,
  name,
  children,
}: {
  type: SfPreviewType | null
  id: string | null
  name: string | null
  children: React.ReactNode
}) {
  if (!type || !id) return <>{children}</>
  return <SfRecordPreview type={type} id={id} fallbackName={name}>{children}</SfRecordPreview>
}

// Tiny inline component so the card can lazy-fetch the current Assigned SE
// per Opportunity without threading a giant prefetch through useActivities.
// Cheap because the SF endpoint is O(1) SOQL and returns immediately if the
// user isn't SF-connected.
// refetchKey is the activity's updatedAt — any save (including the Assigned
// SE picker) bumps it, forcing a fresh SOQL read so the line reflects the
// value we just wrote to Opportunity.Assigned_SE__c.
function AssignedSeLine({ oppId, teamId, activityId, refetchKey, cachedName }: { oppId: string; teamId: string; activityId?: string; refetchKey?: string; cachedName?: string | null }) {
  const { t } = useTranslation()
  const crmApiBase = useCrmApiBase()
  const [name, setName] = useState<string | null>(cachedName ?? null)
  const [loaded, setLoaded] = useState(!!cachedName)
  useEffect(() => {
    if (cachedName) { setName(cachedName); setLoaded(true); return }
    let cancelled = false
    void api.get<{ userId: string | null; userName: string | null }>(`${crmApiBase}/opportunities/${encodeURIComponent(oppId)}/assigned-se?teamId=${encodeURIComponent(teamId)}`)
      .then((res) => {
        if (cancelled) return
        const val = res.data?.userName ?? null
        setName(val)
        setLoaded(true)
        // v1.98.0: lazy backfill — activities created before v1.97 have
        // no cached snapshot. When the live SF read resolves a real
        // value, persist it onto the activity so subsequent renders
        // skip the SF hop. PATCH is a no-op for read-only rows (403);
        // we swallow the error silently.
        if (val && activityId) {
          void api.patch(`/api/activities/${activityId}`, { crmAssignedSeName: val }).catch(() => { /* ignore */ })
        }
      })
    return () => { cancelled = true }
  }, [oppId, teamId, crmApiBase, refetchKey, cachedName, activityId])
  if (!loaded) return null
  return (
    <div className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
      <UserRound className="h-3 w-3 shrink-0 text-gray-500 dark:text-gray-400" />
      <span className="text-gray-500 dark:text-gray-400">{t('activity.assigned_oppty_se', 'Assigned Oppty SE')}:</span>
      <span>{name ?? <span className="text-gray-400 italic">{t('activity.unassigned', 'Unassigned')}</span>}</span>
    </div>
  )
}

// v1.72.0: SF Related chip on the activity card. Renders the admin's
// Display Label ("Evaluations", "Deals", etc.) from the activity type's
// SF Extras config next to the selected record name, and opens the
// SF Activities modal on click. The extras row is fetched once per
// activityTypeId and cached module-scoped, so a week of cards with
// mixed types makes at most N-types requests instead of N-cards.
interface SfExtraCacheRow {
  id: string
  kind: 'opp_field_display' | 'related_object_picker'
  config: { label?: string; sobject?: string }
}
const extrasCache = new Map<string, SfExtraCacheRow[]>()
const extrasPromises = new Map<string, Promise<SfExtraCacheRow[]>>()
async function loadExtras(activityTypeId: string): Promise<SfExtraCacheRow[]> {
  const cached = extrasCache.get(activityTypeId)
  if (cached) return cached
  const inflight = extrasPromises.get(activityTypeId)
  if (inflight) return inflight
  const p = (async () => {
    const res = await api.get<SfExtraCacheRow[]>(`/api/activities/sf-extras/${activityTypeId}`)
    const rows = res.data ?? []
    extrasCache.set(activityTypeId, rows)
    extrasPromises.delete(activityTypeId)
    return rows
  })()
  extrasPromises.set(activityTypeId, p)
  return p
}

function humanizeSobject(api: string | null): string {
  if (!api) return 'Related'
  return api.replace(/__c$/, '').replace(/_/g, ' ')
}

function SfRelatedChip({ activityTypeId, crmRelatedId, crmRelatedType, crmRelatedName, crmEvalType, evalSeed, onOpen, onLabelResolved }: {
  activityTypeId: string
  crmRelatedId: string
  crmRelatedType: string | null
  crmRelatedName: string
  crmEvalType?: string | null
  evalSeed?: ProjectSeed
  onOpen: () => void
  onLabelResolved?: (label: string) => void
}) {
  const { t } = useTranslation()
  const { activeTeam } = useTeam()
  const [label, setLabel] = useState<string>(() => humanizeSobject(crmRelatedType))
  useEffect(() => {
    // Seed the parent's label with the humanized fallback so the modal
    // header isn't blank before the extras fetch resolves.
    onLabelResolved?.(humanizeSobject(crmRelatedType))
    let cancelled = false
    void loadExtras(activityTypeId).then((rows) => {
      if (cancelled) return
      const match = rows.find((r) => r.kind === 'related_object_picker' && r.config.sobject === crmRelatedType)
        ?? rows.find((r) => r.kind === 'related_object_picker')
      const configured = match?.config.label?.trim()
      if (configured) {
        setLabel(configured)
        onLabelResolved?.(configured)
      }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityTypeId, crmRelatedType])
  // v1.74.0: match the Opportunity / Account chip style — plain gray
  // "Label:" prefix + blue link name, no bordered pill. Also swallow
  // the click so it doesn't bubble to the card and open the edit
  // drawer alongside the modal.
  // v1.148.0: icon reflects Evaluation_Type__c once known (POC/Virtual
  // Lab/RTU/Trial/Partner NFR/Partner Lead); falls back to the generic
  // Target used before the type is fetched or for non-Eval related types.
  const Icon = evalTypeIcon(crmEvalType) ?? Target
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
        <Icon className="h-3 w-3 shrink-0" />
        {label}:
      </span>
      {/* v1.222.0: same hover preview as the Opportunity / Account links.
          Needs the org's SF object API name (crmRelatedType) and the team, to
          resolve the eval field mappings — never hardcoded. */}
      {/* v1.388.0: a CriteriaIQ project link isn't a Salesforce record, so it
          gets no Salesforce hover preview; the drill-in shows its details. */}
      {isCriteriaIqProjectLink(crmRelatedType) ? (
        <button
          onClick={(e) => { e.stopPropagation(); onOpen() }}
          className="group inline-flex max-w-[220px] items-center gap-1 truncate text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
          title={t('activity.sf.related_view_for', { name: `${label}: ${crmRelatedName}`, defaultValue: 'View activities for {{name}}' })}
        >
          <span className="truncate">{crmRelatedName}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      ) : (
        <SfRecordPreview
          type="Project"
          id={crmRelatedId}
          fallbackName={crmRelatedName}
          sobject={crmRelatedType}
          teamId={activeTeam?.id ?? null}
          seed={evalSeed}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onOpen() }}
            className="group inline-flex max-w-[220px] items-center gap-1 truncate text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
            title={t('activity.sf.related_view_for', { name: `${label}: ${crmRelatedName}`, defaultValue: 'View activities for {{name}}' })}
          >
            <span className="truncate">{crmRelatedName}</span>
            <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </SfRecordPreview>
      )}
    </span>
  )
}
