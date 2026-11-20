import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { format, differenceInMinutes } from 'date-fns'
import {
  Sparkles,
  CheckCircle2,
  Save,
  Send,
  ChevronDown,
  CalendarPlus,
  Wifi,
  MapPin,
  AlertCircle,
  CalendarOff,
  Trash2,
  Bookmark,
  DollarSign,
  Type,
  Layers,
  Clock,
  Timer,
  Link2,
  Package,
  UserRound,
  Users,
  FileText,
  StickyNote,
  Car,
  BedDouble,
  Utensils,
  UserPlus,
  UserLock,
  SquarePen,
  CloudSync,
  MessageCircleText,
  MessageCircleQuestion,
  Megaphone,
  CircleMinus,
  Loader2,
  GitMerge,
  ClipboardCheck,
} from 'lucide-react'
import { Dialog } from '../ui/dialog.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Textarea } from '../ui/textarea.js'
import { Label } from '../ui/label.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { Select } from '../ui/select.js'
import { SfSearch, type SfSelection } from '../salesforce/SfSearch.js'
import { SfRelationshipHelp } from '../salesforce/SfRelationshipHelp.js'
import { MarkdownHelpPopover } from '../ui/markdown-help.js'
import { AttendeeSuggestions } from './AttendeeSuggestions.js'
import { AttendeeResponseBadge } from '../calendar/AttendeeResponseBadge.js'
import { api } from '../../lib/api.js'
import type { Activity } from '../../hooks/useActivities.js'
import { useTeam, type ActivityType } from '../../hooks/useTeam.js'
import { cn } from '../../lib/utils.js'
import { useTeamProducts } from '../../hooks/useProducts.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useSalesforce } from '../../hooks/useSalesforce.js'
import { isoToLocalInputInTZ, localInputInTZToIso } from '../../lib/tz.js'
import { NotesPanel } from './NotesDrawer.js'
import { useCrmProjects } from '../../store/evaluationSource.js'
import { crmApiBaseFor, useCrmLabelContext, useCrmProvider } from '../../store/crmProvider.js'
import { ActivityTypePicker } from './ActivityTypePicker.js'
import { AssignedSePicker } from './AssignedSePicker.js'
import { AttendeeSfSearchBar, SfContactOwnerPicker } from './AttendeePickers.js'
import { SyncHistoryTab } from './SyncHistoryTab.js'
import { TranscriptsTab } from './TranscriptsTab.js'
import { AiNotesTab } from './AiNotesTab.js'
import type { AiNotesView } from '../../../shared/aiNotes.js'
import type { AiAssessmentsActivityView } from '../../../shared/aiAssessments.js'
import { AiAssessmentsTab } from './AiAssessmentsTab.js'
import type { SyncAuditRow } from './SyncHistoryTab.js'
import { SfExtrasPanel, TicketExtrasPanel, BizNumberBox } from './SfExtrasPanels.js'
import type { TicketAttachment } from './SfExtrasPanels.js'

interface CalendarEventPrefill {
  outlookEventId: string
  title: string
  startDatetime: string
  endDatetime: string
  // Optional pre-classified activity type from the suggestion pipeline
  // (keyword / AI). When provided, the form uses it verbatim instead of
  // re-running the local rule matcher — otherwise the card and drawer
  // could disagree on activity type (card shows Discovery from keyword,
  // form shows Executive Briefing from a title-based rule match).
  activityTypeId?: string | null
  descriptionBody?: string
  meetingOwner?: string
  meetingOwnerEmail?: string | null
  // v1.239.0: response/type (Graph attendee RSVP + required/optional) ride
  // along here so the read-only "meeting responses" summary below can show
  // them — they are NEVER written into the persisted `attendees` FormState
  // field (see the population effect, which maps this down to name/email
  // only for that).
  attendees?: { name?: string; email?: string; response?: string; type?: string }[]
  isAllDay?: boolean
  eventType?: string
  seriesMasterId?: string
  // v1.262.0: Outlook's own sensitivity marking on this event (private or
  // confidential). Snapshotted into activities.isPrivateMeeting on save —
  // see CLAUDE.md §7 Private Meetings.
  isPrivate?: boolean
}

interface ActivityFormProps {
  open: boolean
  onClose: () => void
  onSaved: () => void
  teamId: string
  activityTypes: ActivityType[]
  editActivity?: Activity | null
  prefill?: CalendarEventPrefill | null
  seedTemplateId?: string | null
  isNonActivity?: boolean
  onUnmarkNonActivity?: () => void
  // v1.90.0: currently-loaded Outlook events for the week. When opening
  // Edit on an activity that has an outlookEventId but blank
  // meetingOwner / attendees / descriptionBody (either a legacy row or
  // one saved before the Suggested-card Edit fix), the form falls back to
  // the matching calendar event so the SE sees the same context the
  // Outlook column shows on the right.
  weekEvents?: Array<{ id: string; organizer?: { name: string; email: string }; attendees?: Array<{ name: string; email: string; response?: string; type?: string }>; bodyPreview?: string }>
  // v1.460.0: tab to show when the drawer opens on an existing activity
  // (the card's Transcripts icon passes 'transcripts'). Default: Edit.
  initialTab?: 'edit' | 'transcripts'
}

interface FormState {
  title: string
  activityTypeId: string
  // v1.256.0: optional finer-grained classification under activityTypeId,
  // shown as a second dropdown in the same row when the chosen type has
  // Subtypes AND the team has turned Subtypes on. Never written to
  // Salesforce — see teamActivityTypeSubtypes / activities.subtype_id.
  subtypeId: string | null
  // v1.257.0: only ever populated or shown when the chosen activity type is
  // named "Meeting" — product research so admins can see whether reps keep
  // reaching for the generic type instead of something more specific. See
  // drizzle/schema.ts activities.meetingTypeReason.
  meetingTypeReason: string
  // v1.334.0: same name-matched convention as meetingTypeReason above, for
  // activity type "Marketing" — an optional label for which event/campaign
  // this activity relates to. ImpactIQ-only, never written to Salesforce.
  marketingEventName: string
  startDatetime: string
  endDatetime: string
  effortHours: string
  notes: string
  descriptionBody: string
  locationMode: 'remote' | 'onsite'
  meetingOwner: string
  meetingOwnerEmail: string | null
  attendees: { name?: string; email?: string }[]
  acv: string
  // Incidental/travel spend on a Remote activity ("Direct Costs"), entered in
  // the user's display currency (incidentalCurrency).
  incidentalTransportation: string
  incidentalLodging: string
  incidentalFood: string
  incidentalCurrency: string
  // Snapshot fields captured when linking to an SF Opportunity — the
  // display grays these out; the write path passes them through so
  // reports reflect the state at meeting time.
  salesStage: string | null
  forecastCategory: string | null
  oppAmount: string | null
  oppCloseDate: string | null
  // v1.67.0: SF child link populated by per-activity-type Extras
  // (e.g. Eval Work → Evaluation__c).
  crmRelatedType: string | null
  crmRelatedId: string | null
  crmRelatedName: string | null
  outlookEventId: string
  // v1.262.0: approval-time snapshot of the Outlook event's own privacy
  // marking. Not a form field the contributor edits directly — carried
  // through from prefill/editActivity so the card treatment (masked
  // title, lock icon) is preserved on save. See CLAUDE.md §7.
  isPrivateMeeting: boolean
}

// Kept as a fallback for edge callers that don't know the user's TZ;
// prefer isoToLocalInputInTZ from lib/tz.ts everywhere inside the
// component itself.
function toDateTimeLocal(iso: string) {
  return iso.slice(0, 16)
}

function computeEffortHours(start: string, end: string): string {
  const mins = differenceInMinutes(new Date(end), new Date(start))
  return (Math.max(0, mins) / 60).toFixed(2)
}

function serializeAttendees(list: { name?: string; email?: string }[]): string {
  return list.map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : a.name ?? a.email ?? '')).join('\n')
}

function parseAttendees(text: string): { name?: string; email?: string }[] {
  return text
    .split(/[\n;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.+?)\s*<(.+@.+)>\s*$/)
      return m ? { name: m[1], email: m[2] } : /@/.test(line) ? { email: line } : { name: line }
    })
}

export function ActivityForm({
  open,
  onClose,
  onSaved,
  teamId,
  activityTypes,
  editActivity,
  prefill,
  weekEvents,
  seedTemplateId,
  isNonActivity,
  onUnmarkNonActivity,
  initialTab = 'edit',
}: ActivityFormProps) {
  const { t } = useTranslation()
  // Which CRM the install uses: search and preview calls go to its routes.
  const crmProvider = useCrmProvider()
  const crmCtx = useCrmLabelContext()
  const crmApiBase = crmApiBaseFor(crmProvider)
  const [form, setForm] = useState<FormState>({
    title: '',
    activityTypeId: activityTypes[0]?.id ?? '',
    subtypeId: null,
    meetingTypeReason: '',
    marketingEventName: '',
    isPrivateMeeting: false,
    startDatetime: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    endDatetime: format(new Date(Date.now() + 60 * 60 * 1000), "yyyy-MM-dd'T'HH:mm"),
    effortHours: '1.00',
    notes: '',
    descriptionBody: '',
    locationMode: 'remote',
    meetingOwner: '',
    meetingOwnerEmail: null,
    attendees: [],
    acv: '',
    incidentalTransportation: '',
    incidentalLodging: '',
    incidentalFood: '',
    incidentalCurrency: '',
    salesStage: null,
    forecastCategory: null,
    oppAmount: null,
    oppCloseDate: null,
    crmRelatedType: null,
    crmRelatedId: null,
    crmRelatedName: null,
    outlookEventId: '',
  })
  const [sfSelection, setSfSelection] = useState<SfSelection | null>(null)
  // v1.270.0: Opportunity search hides Closed opps by default (see
  // SfSearch.tsx) — this opts back in. Off by default since most logging
  // is against still-open deals; lives on the field's own label row (not
  // inside the search popover) so it's visible before the user even opens it.
  const [sfShowClosedOpps, setSfShowClosedOpps] = useState(false)
  // v1.294.0: the Total ACV field shows a plain editable number while
  // focused, and a comma-formatted read style (matching the Opp Amount (SF)
  // box beside it) once blurred — a bare `type="number"` input can't render
  // thousands separators while still accepting free numeric entry.
  const [acvFocused, setAcvFocused] = useState(false)
  // Incidental (Direct) costs: the user's display currency for symbol + capture,
  // and whether the entry modal is open.
  const [prefCurrency, setPrefCurrency] = useState('USD')
  const [incidentalOpen, setIncidentalOpen] = useState(false)
  // v1.254.0: "post my Notes text to the linked Project's Engineer Notes
  // field" — a prepend-update, not an overwrite (see SfFieldPrependPanel).
  // Fires once at Save, then unchecks itself so re-saving the same
  // activity without re-checking it doesn't double-post identical text.
  const [postToEngineerNotes, setPostToEngineerNotes] = useState(false)
  const [engineerNotesError, setEngineerNotesError] = useState<string | null>(null)
  // v1.387.0: with Projects off (Admin → Integrations → Projects) the
  // Engineer Notes checkbox is never offered.
  // Engineer Notes posts to the CRM's own Evaluation record, so it's offered
  // only while that object is the Project source (not with Projects off or
  // with CriteriaIQ as the primary source).
  const crmProjects = useCrmProjects()
  // v1.307.0: "Post: Opp Notes" / "Post: Acct Notes" — same idea as Engineer
  // Notes above, but pushes the create-mode Notes text as a Salesforce
  // ContentNote via the same POST /api/notes/:id/push pipeline NotesDrawer's
  // NotesPanel (the edit-mode Notes tab) and My Notes' own Push button use.
  // Only reachable in create mode since edit mode's Notes tab is NotesPanel
  // itself, which has its own identical checkboxes.
  const [postToOppNotes, setPostToOppNotes] = useState(false)
  const [postToAcctNotes, setPostToAcctNotes] = useState(false)
  const [sfNotesPushError, setSfNotesPushError] = useState<string | null>(null)
  // Same derivation as the crmAccountId/crmAccountName save-payload fields
  // above (sfSelection.extra.accountId/accountName for an Opportunity pick)
  // — computed once here so both the checkbox visibility below and the
  // submit handler's push call agree on the exact same targets.
  const oppNotesPushTarget = sfSelection?.type === 'Opportunity' && sfSelection.id
    ? { crmType: 'Opportunity' as const, sfId: sfSelection.id, sfName: sfSelection.name ?? null }
    : null
  const acctNotesPushTarget = sfSelection?.type === 'Account' && sfSelection.id
    ? { crmType: 'Account' as const, sfId: sfSelection.id, sfName: sfSelection.name ?? null }
    : sfSelection?.type === 'Opportunity' && sfSelection.extra?.accountId
      ? { crmType: 'Account' as const, sfId: sfSelection.extra.accountId, sfName: sfSelection.extra.accountName ?? null }
      : null
  // v1.337.0: same accountId derivation as crmAccountId in the save payload
  // below (an Opportunity's parent Account, or a direct Account pick) —
  // hoisted here so SfExtrasPanel's ticket picker can default-scope to the
  // connected Account without duplicating the derivation a third time.
  const derivedSfAccountId = sfSelection?.type === 'Opportunity'
    ? (sfSelection.extra?.accountId ?? null)
    : sfSelection?.type === 'Account'
      ? sfSelection.id
      : null
  useEffect(() => {
    let cancelled = false
    void api.get<{ code: string | null }>('/auth/me/preferred-currency').then((res) => {
      if (!cancelled && res.data?.code) setPrefCurrency(res.data.code)
    })
    return () => { cancelled = true }
  }, [])
  // v1.104.0: single seeding path for the SF selection so BOTH the
  // SfSearch popover pick and the <AttendeeSuggestions> quick-pick end
  // up producing the same ACV + snapshot state. Previously
  // AttendeeSuggestions only called setSfSelection(sel), bypassing the
  // seed logic, which is why editing a suggested Outlook meeting and
  // picking the same Opp left ACV / Amount / Stage / Forecast / Close
  // Date blank.
  function applySfSelection(sel: SfSelection | null) {
    setSfSelection(sel)
    if (sel?.type === 'Opportunity' && sel.extra) {
      setForm((f) => ({
        ...f,
        acv: sel.extra?.amount != null ? String(sel.extra.amount) : f.acv,
        salesStage: sel.extra?.stageName ?? null,
        forecastCategory: sel.extra?.forecastCategoryName ?? null,
        oppAmount: sel.extra?.amount != null ? String(sel.extra.amount) : null,
        oppCloseDate: sel.extra?.closeDate ?? null,
      }))
    } else if (sel?.type !== 'Opportunity') {
      setForm((f) => ({ ...f, salesStage: null, forecastCategory: null, oppAmount: null, oppCloseDate: null }))
    }
    // A new/cleared SF selection invalidates whatever business breakdown
    // was fetched for the previous Opportunity — collapse and drop it
    // rather than let stale numbers linger under the new record.
    setSfBusinessExpanded(false)
    setSfBusinessNumbers(null)
  }

  // v1.293.0: Total Bookings breakdown (New Business / Renewals ACV & TCV) —
  // live-only, no persisted snapshot column, so it's fetched on demand
  // rather than carried on `form`. Reuses the same live-preview endpoint the
  // hover popover uses (GET /api/salesforce/preview/Opportunity/:id) instead
  // of a second endpoint — see CLAUDE.md §9.
  const [sfBusinessExpanded, setSfBusinessExpanded] = useState(false)
  const [sfBusinessLoading, setSfBusinessLoading] = useState(false)
  const [sfBusinessNumbers, setSfBusinessNumbers] = useState<{ newBusinessAcv: string | null; newBusinessTcv: string | null; renewalAcv: string | null; renewalTcv: string | null } | null>(null)

  async function toggleSfBusinessExpanded() {
    const next = !sfBusinessExpanded
    setSfBusinessExpanded(next)
    if (!next || sfBusinessNumbers || sfSelection?.type !== 'Opportunity') return
    setSfBusinessLoading(true)
    try {
      const res = await api.get<{ newBusinessAcv: string | null; newBusinessTcv: string | null; renewalAcv: string | null; renewalTcv: string | null }>(
        `${crmApiBase}/preview/Opportunity/${encodeURIComponent(sfSelection.id)}`,
      )
      if (res.data) {
        setSfBusinessNumbers({
          newBusinessAcv: res.data.newBusinessAcv,
          newBusinessTcv: res.data.newBusinessTcv,
          renewalAcv: res.data.renewalAcv,
          renewalTcv: res.data.renewalTcv,
        })
      }
    } catch {
      // Preview endpoint always answers 200 in practice; this is just a
      // network-failure backstop so the panel shows dashes instead of hanging.
    }
    setSfBusinessLoading(false)
  }
  const [attendeesText, setAttendeesText] = useState('')
  // v1.319.0: raw typed text for the Meeting owner input, mirroring
  // attendeesText above — the input shows/accepts "Name <email>" (same
  // convention as Attendees) while form.meetingOwner/meetingOwnerEmail stay
  // the parsed, separately-persisted fields.
  const [meetingOwnerText, setMeetingOwnerText] = useState('')
  // v1.239.0: read-only "meeting responses" summary data — sourced from a
  // live Outlook event (prefill) or a matching weekEvents entry (edit),
  // carrying response/type. Deliberately separate from `form.attendees`
  // (which stays name/email-only, persisted): this is display-only context
  // that's never saved with the activity.
  const [attendeeResponses, setAttendeeResponses] = useState<{ name?: string; email?: string; response?: string; type?: string }[]>([])
  // Assigned SE currently persisted on the Opportunity (initial), and the
  // user's picked value in-form. When they differ on save we PATCH the SF
  // Opportunity — otherwise skip the extra round-trip.
  const [initialAssignedSe, setInitialAssignedSe] = useState<{ userId: string | null; userName: string | null; matched: boolean | null }>({ userId: null, userName: null, matched: null })
  const [assignedSe, setAssignedSe] = useState<{ userId: string | null; userName: string | null; matched: boolean | null }>({ userId: null, userName: null, matched: null })
  // HubSpot (phase 6) reports whether the team maps an Assigned SE deal
  // property at all, and whether this user may change Deals (they must be a
  // HubSpot user in the portal). Salesforce sends neither: always shown.
  const [assignedSeMeta, setAssignedSeMeta] = useState<{ configured: boolean; canWrite: boolean; readOnlyReason: string | null }>({ configured: true, canWrite: true, readOnlyReason: null })

  useEffect(() => {
    if (sfSelection?.type !== 'Opportunity') {
      setInitialAssignedSe({ userId: null, userName: null, matched: null })
      setAssignedSe({ userId: null, userName: null, matched: null })
      return
    }
    let cancelled = false
    void api.get<{ userId: string | null; userName: string | null; matched: boolean | null }>(`${crmApiBase}/opportunities/${encodeURIComponent(sfSelection.id)}/assigned-se?teamId=${encodeURIComponent(teamId)}`)
      .then((res) => {
        if (cancelled) return
        const val = res.data ?? { userId: null, userName: null, matched: null }
        setInitialAssignedSe(val)
        setAssignedSe(val)
        setAssignedSeMeta({ configured: res.meta['configured'] !== false, canWrite: res.meta['canWrite'] !== false, readOnlyReason: typeof res.meta['readOnlyReason'] === 'string' ? res.meta['readOnlyReason'] : null })
      })
    return () => { cancelled = true }
  }, [sfSelection?.id, sfSelection?.type, teamId, crmApiBase])
  const [productIds, setProductIds] = useState<string[]>([])
  // v1.337.0: multi-valued Salesforce ticket attachment (see the
  // 'ticket_picker' Extra rendered by SfExtrasPanel below). Same
  // separate-state + hydrate-on-edit pattern as productIds above; sending
  // the array on save replaces the full attached set.
  const [tickets, setTickets] = useState<TicketAttachment[]>([])
  // v1.341.0: true while the background snapshot-refresh (below) is in
  // flight against Salesforce — drives a small spinner near the ticket
  // list. Never gates the drawer's own open/render.
  const [ticketsRefreshing, setTicketsRefreshing] = useState(false)
  // v1.344.0: live, per-activity companion to the nightly detect_disconnected_
  // links job (CLAUDE.md §7/§11) — fires once when editing an activity with
  // at least one SF link, so whoever is looking at this record right now
  // sees a check more current than the nightly batch. Purely informational:
  // no field is locked or blocked by it.
  const [sfLinkStatus, setSfLinkStatus] = useState<{ crmWhatDeleted?: boolean; crmWhoDeleted?: boolean; crmRelatedDeleted?: boolean } | null>(null)
  const [sfLinkStatusChecking, setSfLinkStatusChecking] = useState(false)
  const [sfLinkMoved, setSfLinkMoved] = useState(false)
  const teamProducts = useTeamProducts(teamId)
  // v1.256.0: Subtype picker data — subtypesByTypeId is fetched once in the
  // team store (shared with Guide.tsx/TemplatesSection.tsx); subtypesEnabled
  // is looked up by the explicit teamId prop rather than `activeTeam` so it
  // still resolves correctly if this form is ever opened while "All Teams"
  // is the sidebar selection.
  const { subtypesByTypeId, teams: allTeams } = useTeam()
  const subtypesEnabled = !!allTeams.find((tm) => tm.id === teamId)?.subtypesEnabled
  const currentSubtypes = subtypesByTypeId[form.activityTypeId] ?? []
  const showSubtypePicker = subtypesEnabled && currentSubtypes.length > 0
  // v1.257.0: name-matched the same way Guide.tsx already special-cases
  // Meeting (activityTypes.filter(at => at.name !== 'Meeting')) — Meeting
  // is a well-known seeded type name, not a hardcoded team/slug.
  const isMeetingType = activityTypes.find((at) => at.id === form.activityTypeId)?.name === 'Meeting'
  // v1.334.0: same name-matched convention, for the optional Event Name field.
  const isMarketingType = activityTypes.find((at) => at.id === form.activityTypeId)?.name === 'Marketing'
  const { user: currentUser } = useCurrentUser()
  const { status: crmStatus } = useSalesforce()
  const sfConnected = !!crmStatus?.connected
  const userTz = currentUser?.timezone ?? null
  // v1.162.0: effective internal email domains, so the write-back note can
  // name who gets an Outlook invite. Only fetched when write-back is on.
  const [internalDomains, setInternalDomains] = useState<string[]>([])
  useEffect(() => {
    if (!currentUser?.outlookWritebackEnabled) return
    void api.get<{ internalDomains: string[] }>('/api/outlook/writeback-config').then((r) => setInternalDomains(r.data?.internalDomains ?? []))
  }, [currentUser?.outlookWritebackEnabled])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typeSuggested, setTypeSuggested] = useState(false)
  const [suggestionSource, setSuggestionSource] = useState<'keyword' | 'ai' | null>(null)
  // Warnings raised when the source calendar event is all-day, recurring, or
  // spans multiple days — surface so the SE trims Effort Hours to something
  // realistic before saving.
  const [prefillWarnings, setPrefillWarnings] = useState<Array<'all_day' | 'recurring' | 'multi_day'>>([])
  const [activeTab, setActiveTab] = useState<'edit' | 'notes' | 'sync' | 'transcripts' | 'ai_notes' | 'assessments'>('edit')
  // v1.460.0: each open starts on the requested tab (Edit unless the card's
  // Transcripts icon asked for Transcripts), instead of whatever tab the
  // previous activity was left on.
  useEffect(() => {
    if (open) setActiveTab(initialTab)
  }, [open, editActivity?.id, initialTab])
  // Sync History tab count — fetched independently of which tab is active
  // (mirrors editActivity.notesCount, which arrives for free on the
  // activity row) so the tab label reads correctly before it's ever
  // clicked, not just after SyncHistoryTab has mounted once.
  const [syncCount, setSyncCount] = useState<number | null>(null)
  useEffect(() => {
    if (!editActivity) { setSyncCount(null); return }
    let cancelled = false
    api.get<SyncAuditRow[]>(`/api/activities/${editActivity.id}/sync-audit`).then((res) => {
      if (!cancelled) setSyncCount(res.data?.length ?? 0)
    })
    return () => { cancelled = true }
  }, [editActivity?.id])
  // Transcripts tab (Gong): shown only when Gong is connected and Role
  // Management grants activities.transcripts. The count is fetched up front,
  // like Sync History's, so the label is right before the tab is opened.
  const [transcriptsEnabled, setTranscriptsEnabled] = useState(false)
  const [transcriptCount, setTranscriptCount] = useState<number | null>(null)
  useEffect(() => {
    if (!editActivity) { setTranscriptCount(null); return }
    let cancelled = false
    api.get<{ enabled: boolean }>(`/api/gong/status?activityId=${encodeURIComponent(editActivity.id)}`).then((res) => {
      if (cancelled) return
      const enabled = res.data?.enabled === true
      setTranscriptsEnabled(enabled)
      if (!enabled) { setTranscriptCount(null); return }
      api.get<{ calls: unknown[] }>(`/api/gong/activities/${editActivity.id}/calls`).then((r) => {
        if (!cancelled) setTranscriptCount(r.data?.calls.length ?? 0)
      })
    })
    return () => { cancelled = true }
  }, [editActivity?.id])
  // AI Notes tab (Gong plan, phase 4): shown only when the server says so
  // (AI Assistant + the team's AI Notes switch on, Role Management grant,
  // and the viewer may read this activity's AI Note).
  const [aiNotesEnabled, setAiNotesEnabled] = useState(false)
  const [aiNotesCount, setAiNotesCount] = useState<number | null>(null)
  useEffect(() => {
    setAiNotesEnabled(false)
    if (!editActivity) { setAiNotesCount(null); return }
    let cancelled = false
    api.get<AiNotesView>(`/api/ai-notes/activities/${editActivity.id}`).then((res) => {
      if (cancelled) return
      setAiNotesEnabled(res.data?.enabled === true)
      setAiNotesCount(res.data?.items.length ?? null)
    })
    return () => { cancelled = true }
  }, [editActivity?.id])
  // Assessments tab (v1.462.0): Leaders only, never the activity's owner,
  // and only when assessments are assigned or scores exist.
  const [assessmentsVisible, setAssessmentsVisible] = useState(false)
  const [assessmentsCount, setAssessmentsCount] = useState<number | null>(null)
  useEffect(() => {
    setAssessmentsVisible(false)
    if (!editActivity) { setAssessmentsCount(null); return }
    let cancelled = false
    api.get<AiAssessmentsActivityView>(`/api/ai-assessments/activities/${editActivity.id}`).then((res) => {
      if (cancelled) return
      setAssessmentsVisible(res.data?.visible === true)
      setAssessmentsCount(res.data?.scores.length ?? null)
    })
    return () => { cancelled = true }
  }, [editActivity?.id])
  const [deletePromptOpen, setDeletePromptOpen] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleteNotes, setDeleteNotes] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // v1.159.0: when the activity was written to Outlook, offer to remove that
  // calendar event too (default on, so a deleted activity doesn't linger in
  // Outlook and reappear as an unapproved suggestion).
  const [deleteOutlookEvent, setDeleteOutlookEvent] = useState(true)
  const wroteToOutlook = editActivity?.outlookSyncStatus === 'synced'

  async function confirmDelete() {
    if (!editActivity) return
    if (deleteConfirmText.trim().toLowerCase() !== 'delete') return
    setDeleting(true)
    setDeleteError(null)
    // api.delete doesn't send bodies — flags go on the query string.
    const params = new URLSearchParams()
    if (deleteNotes) params.set('deleteNotes', '1')
    if (wroteToOutlook && deleteOutlookEvent) params.set('deleteOutlookEvent', '1')
    const qs = params.toString()
    const url = `/api/activities/${editActivity.id}${qs ? `?${qs}` : ''}`
    const res = await api.delete(url)
    setDeleting(false)
    if (res.error) {
      setDeleteError(res.error)
      return
    }
    setDeletePromptOpen(false)
    setDeleteConfirmText('')
    setDeleteNotes(false)
    onSaved()
    onClose()
  }
  // Tracks whether the user has touched the form since it was opened.
  // Reset when the drawer opens; flipped true on every field edit via
  // set(). Used to prompt on close.
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (open) setDirty(false) }, [open, editActivity, prefill])

  function requestClose() {
    if (!dirty) { onClose(); return }
    // Three-way choice: Save as draft, Discard, Cancel.
    const action = window.prompt(
      t('activity.form.close_prompt', {
        defaultValue: 'You have unsaved changes.\n\nType "save" to save as a draft, "discard" to lose your changes, or leave blank to keep editing.',
      }),
      '',
    )
    if (action === null) return
    const v = action.trim().toLowerCase()
    if (v === '' || v === 'cancel') return
    if (v === 'save' || v === 'draft') {
      void handleSave('draft')
      return
    }
    if (v === 'discard') {
      onClose()
      return
    }
    // Anything else: keep the form open.
  }
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; titleTemplate: string; notesTemplate: string | null; activityTypeId: string | null; subtypeId: string | null; effortHoursDefault: string | null; locationModeDefault: string | null; productIds: string[] | null }>>([])
  useEffect(() => {
    if (!open || editActivity) return
    void api.get<typeof templates>('/api/templates').then((res) => {
      const list = res.data ?? []
      setTemplates(list)
      if (seedTemplateId) {
        const seed = list.find((tp) => tp.id === seedTemplateId)
        if (seed) {
          setForm((f) => ({
            ...f,
            title: seed.titleTemplate,
            notes: seed.notesTemplate ?? f.notes,
            activityTypeId: seed.activityTypeId ?? f.activityTypeId,
            subtypeId: seed.subtypeId ?? f.subtypeId,
            effortHours: seed.effortHoursDefault ?? f.effortHours,
            locationMode: (seed.locationModeDefault as 'remote' | 'onsite' | null) ?? f.locationMode,
          }))
          if (Array.isArray(seed.productIds) && seed.productIds.length > 0) setProductIds(seed.productIds)
        }
      }
    })
  }, [open, editActivity, seedTemplateId])

  function applyTemplate(tplId: string) {
    const tpl = templates.find((tt) => tt.id === tplId)
    if (!tpl) return
    setForm((f) => ({
      ...f,
      title: tpl.titleTemplate,
      notes: tpl.notesTemplate ?? f.notes,
      activityTypeId: tpl.activityTypeId ?? f.activityTypeId,
      subtypeId: tpl.subtypeId ?? f.subtypeId,
      effortHours: tpl.effortHoursDefault ?? f.effortHours,
      locationMode: (tpl.locationModeDefault as 'remote' | 'onsite' | null) ?? f.locationMode,
    }))
    if (Array.isArray(tpl.productIds) && tpl.productIds.length > 0) setProductIds(tpl.productIds)
  }

  // When editing, hydrate productIds from the GET-by-id endpoint (which
  // returns the linked product ids alongside the row).
  useEffect(() => {
    if (!open) { setProductIds([]); return }
    if (!editActivity) { setProductIds([]); return }
    void api.get<{ productIds?: string[] }>(`/api/activities/${editActivity.id}`).then((res) => {
      setProductIds(res.data?.productIds ?? [])
    })
  }, [open, editActivity?.id])

  // Same hydration for attached tickets (see the tickets useState above).
  // v1.341.0: once the stored snapshot is hydrated, kick off a second,
  // non-blocking refresh against Salesforce so stale fields (e.g. Ticket
  // Owner after a person <-> Queue reassignment, see CLAUDE.md §7) self-heal
  // without ever delaying the drawer's own open — the drawer has already
  // rendered with the snapshot by the time this fires. Best-effort: a
  // failure (not connected, describe error, etc.) just keeps the existing
  // snapshot, same degrade-gracefully contract as the server route itself.
  useEffect(() => {
    if (!open) { setTickets([]); setTicketsRefreshing(false); return }
    if (!editActivity) { setTickets([]); setTicketsRefreshing(false); return }
    let cancelled = false
    const activityId = editActivity.id
    void api.get<{ tickets?: Array<{ crmTicketId: string; crmTicketNumber: string; crmSubject: string | null; crmDateOpened: string | null; crmStatus: string | null; crmContact: string | null; crmDescription: string | null; crmPlatform: string | null; crmOwner: string | null }> }>(`/api/activities/${activityId}`).then((res) => {
      if (cancelled) return
      const hydrated = (res.data?.tickets ?? []).map((tk) => ({
        crmTicketId: tk.crmTicketId,
        crmTicketNumber: tk.crmTicketNumber,
        crmSubject: tk.crmSubject,
        crmDateOpened: tk.crmDateOpened,
        crmStatus: tk.crmStatus,
        crmContact: tk.crmContact,
        crmDescription: tk.crmDescription,
        crmPlatform: tk.crmPlatform,
        crmOwner: tk.crmOwner,
      }))
      setTickets(hydrated)
      if (hydrated.length === 0) return
      setTicketsRefreshing(true)
      void api.get<Array<{ crmTicketId: string; crmSubject: string | null; crmDateOpened: string | null; crmStatus: string | null; crmContact: string | null; crmDescription: string | null; crmPlatform: string | null; crmOwner: string | null }>>(`${crmApiBaseFor(crmProvider)}/tickets/refresh?activityId=${activityId}`)
        .then((refreshRes) => {
          if (cancelled) return
          const fresh = refreshRes.data
          if (!Array.isArray(fresh) || fresh.length === 0) return
          setTickets((current) => current.map((tk) => {
            const match = fresh.find((f) => f.crmTicketId === tk.crmTicketId)
            return match ? { ...tk, ...match } : tk
          }))
        })
        .catch(() => { /* best-effort — keep the existing snapshot on failure */ })
        .finally(() => { if (!cancelled) setTicketsRefreshing(false) })
    })
    return () => { cancelled = true }
  }, [open, editActivity?.id])

  // v1.344.0: live SF link-status check, fired once per drawer open on an
  // activity with at least one SF link (What/Who/Related). Non-blocking —
  // never gates the drawer's own render — and best-effort: a failure just
  // leaves sfLinkStatus null, same degrade-gracefully contract as the
  // ticket-refresh effect above.
  useEffect(() => {
    if (!open || !editActivity) { setSfLinkStatus(null); setSfLinkStatusChecking(false); setSfLinkMoved(false); return }
    if (!editActivity.crmWhatId && !editActivity.crmWhoId && !editActivity.crmRelatedId) { setSfLinkStatus(null); return }
    let cancelled = false
    setSfLinkStatusChecking(true)
    setSfLinkMoved(false)
    void api.get<{ crmWhatDeleted: boolean; crmWhoDeleted: boolean; crmRelatedDeleted: boolean }>(`${crmApiBaseFor(crmProvider)}/activity-link-status?activityId=${editActivity.id}`)
      .then((res) => {
        if (cancelled || !res.data) return
        setSfLinkStatus(res.data)
        // HubSpot merged a linked record into another: the server already
        // moved the link, so follow it here or a save would put the old id back.
        const moved = res.meta['moved'] as Partial<Record<'what' | 'who' | 'related', { from: string; to: string }>> | undefined
        if (!moved) return
        setSfLinkMoved(true)
        const sel = moved.what ?? moved.who
        if (sel) setSfSelection((s) => (s && s.id === sel.from ? { ...s, id: sel.to } : s))
        if (moved.related) {
          const rel = moved.related
          setForm((f) => (f.crmRelatedId === rel.from ? { ...f, crmRelatedId: rel.to } : f))
        }
      })
      .catch(() => { /* best-effort — no banner rather than an error */ })
      .finally(() => { if (!cancelled) setSfLinkStatusChecking(false) })
    return () => { cancelled = true }
  }, [open, editActivity?.id, crmProvider])

  // Populate form when editing or from calendar prefill.
  // v1.163.0: `weekEvents` is a dep so the editActivity branch re-hydrates
  // blank Outlook fields once the calendar resolves. But it also changes when
  // the calendar refetches (e.g. on tab focus) — which previously RE-RAN the
  // prefill/new branches and wiped what the user had typed. Guard those two
  // branches so they only initialize on a genuinely new open (init key
  // changed), not on every weekEvents change.
  const formInitKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) { formInitKeyRef.current = null; return }
    const initKey = editActivity ? `edit:${editActivity.id}` : prefill ? `prefill:${prefill.outlookEventId ?? prefill.title}` : 'new'
    const sameInit = formInitKeyRef.current === initKey
    formInitKeyRef.current = initKey
    if (editActivity) {
      // Once the user has started editing, a calendar refetch must not
      // overwrite their changes. Before they touch anything (dirty=false) we
      // still re-hydrate blank Outlook fields when weekEvents resolves.
      if (sameInit && dirty) return
      // v1.90.0: rehydrate blank Outlook fields from the live calendar
      // event when the activity is linked. Covers legacy rows saved
      // before the Suggested-card Edit fix + one-off cases where the
      // form was previously saved with empty organizer/attendees.
      const evtMatch = editActivity.outlookEventId && weekEvents
        ? weekEvents.find((e) => e.id === editActivity.outlookEventId)
        : null
      const fallbackOwner = editActivity.meetingOwner
        ?? (evtMatch?.organizer ? (evtMatch.organizer.name || evtMatch.organizer.email) : null)
      // Prefer the stored email. A legacy activity (approved before
      // v1.319.0 added this column) has a stored name but a null email —
      // if the live calendar event's organizer name matches the stored
      // owner name, backfill from it (a real match, not a guess). Never
      // invent an email when the stored name doesn't match the live event.
      const ownerNameMatchesEvent = !!evtMatch?.organizer && !!fallbackOwner
        && evtMatch.organizer.name.trim().toLowerCase() === fallbackOwner.trim().toLowerCase()
      const fallbackOwnerEmail = editActivity.meetingOwnerEmail
        ?? (!editActivity.meetingOwner || ownerNameMatchesEvent ? (evtMatch?.organizer?.email ?? null) : null)
      const fallbackAttendees = (editActivity.attendees && editActivity.attendees.length > 0)
        ? editActivity.attendees
        : (evtMatch?.attendees?.map((a) => ({ name: a.name, email: a.email })) ?? [])
      const fallbackDescription = editActivity.descriptionBody ?? evtMatch?.bodyPreview ?? ''
      setForm({
        title: editActivity.title,
        activityTypeId: editActivity.activityTypeId,
        subtypeId: editActivity.subtypeId ?? null,
        meetingTypeReason: editActivity.meetingTypeReason ?? '',
        marketingEventName: editActivity.marketingEventName ?? '',
        isPrivateMeeting: editActivity.isPrivateMeeting ?? false,
        startDatetime: isoToLocalInputInTZ(editActivity.startDatetime, userTz),
        endDatetime: isoToLocalInputInTZ(editActivity.endDatetime, userTz),
        effortHours: editActivity.effortHours,
        notes: editActivity.notes ?? '',
        descriptionBody: fallbackDescription,
        locationMode: editActivity.locationMode ?? 'remote',
        meetingOwner: fallbackOwner ?? '',
        meetingOwnerEmail: fallbackOwnerEmail,
        attendees: fallbackAttendees,
        acv: editActivity.acv ?? '',
        incidentalTransportation: editActivity.costTransportation ?? '',
        incidentalLodging: editActivity.costLodging ?? '',
        incidentalFood: editActivity.costFood ?? '',
        incidentalCurrency: editActivity.incidentalCurrency ?? '',
        salesStage: editActivity.salesStage ?? null,
        forecastCategory: editActivity.forecastCategory ?? null,
        oppAmount: editActivity.oppAmount ?? null,
        oppCloseDate: editActivity.oppCloseDate ?? null,
        crmRelatedType: (editActivity as { crmRelatedType?: string | null }).crmRelatedType ?? null,
        crmRelatedId: (editActivity as { crmRelatedId?: string | null }).crmRelatedId ?? null,
        crmRelatedName: (editActivity as { crmRelatedName?: string | null }).crmRelatedName ?? null,
        outlookEventId: '',
      })
      setAttendeesText(serializeAttendees(fallbackAttendees))
      setMeetingOwnerText(serializeAttendees([{ name: fallbackOwner ?? undefined, email: fallbackOwnerEmail ?? undefined }]))
      setAttendeeResponses(evtMatch?.attendees ?? [])
      setSfSelection(
        editActivity.crmWhatId && editActivity.crmWhatType && editActivity.crmWhatName
          ? { id: editActivity.crmWhatId, name: editActivity.crmWhatName, type: editActivity.crmWhatType }
          : editActivity.crmWhoId && editActivity.crmWhoType && editActivity.crmWhoName
          ? { id: editActivity.crmWhoId, name: editActivity.crmWhoName, type: editActivity.crmWhoType }
          : null,
      )
      setTypeSuggested(false)
      setPrefillWarnings([])
    } else if (prefill) {
      if (sameInit) return // don't clobber user edits when weekEvents refetches
      const warnings: Array<'all_day' | 'recurring' | 'multi_day'> = []
      const start = new Date(prefill.startDatetime)
      const end = new Date(prefill.endDatetime)
      const rawHours = Number(computeEffortHours(prefill.startDatetime, prefill.endDatetime))
      const spansMultiDay = start.toDateString() !== end.toDateString() || rawHours > 12
      if (prefill.isAllDay) warnings.push('all_day')
      if (prefill.eventType === 'seriesMaster' || prefill.eventType === 'occurrence' || prefill.eventType === 'exception') warnings.push('recurring')
      if (spansMultiDay && !prefill.isAllDay) warnings.push('multi_day')
      // Clamp the auto-suggested effort so bogus 24h/multi-day values don't
      // silently make it into the record. The SE can still edit freely.
      const hours = warnings.length > 0 ? '1.00' : rawHours.toFixed(2)
      // If the caller passed a pre-classified activityTypeId (from the
      // suggestion pipeline), use it verbatim so the card and the form
      // agree. Otherwise fall back to the first active type and let
      // suggestActivityType override it below.
      const seededTypeId = (prefill.activityTypeId && activityTypes.some((t) => t.id === prefill.activityTypeId))
        ? prefill.activityTypeId
        : activityTypes[0]?.id ?? ''
      setForm({
        title: prefill.title,
        activityTypeId: seededTypeId,
        // Calendar prefills never carry an ImpactIQ Subtype — Outlook has
        // no concept of one.
        subtypeId: null,
        meetingTypeReason: '',
        marketingEventName: '',
        isPrivateMeeting: prefill.isPrivate ?? false,
        startDatetime: isoToLocalInputInTZ(prefill.startDatetime, userTz),
        endDatetime: isoToLocalInputInTZ(prefill.endDatetime, userTz),
        effortHours: hours,
        notes: '',
        descriptionBody: prefill.descriptionBody ?? '',
        locationMode: 'remote',
        meetingOwner: prefill.meetingOwner ?? '',
        meetingOwnerEmail: prefill.meetingOwnerEmail ?? null,
        // v1.239.0: strip response/type here — this is the PERSISTED field.
        // The full data (with response/type) is kept separately in
        // attendeeResponses, below, for the read-only summary only.
        attendees: (prefill.attendees ?? []).map((a) => ({ name: a.name, email: a.email })),
        acv: '',
        incidentalTransportation: '',
        incidentalLodging: '',
        incidentalFood: '',
        incidentalCurrency: '',
        salesStage: null,
        forecastCategory: null,
        oppAmount: null,
        oppCloseDate: null,
        crmRelatedType: null,
        crmRelatedId: null,
        crmRelatedName: null,
        outlookEventId: prefill.outlookEventId,
      })
      setAttendeesText(serializeAttendees(prefill.attendees ?? []))
      setMeetingOwnerText(serializeAttendees([{ name: prefill.meetingOwner ?? undefined, email: prefill.meetingOwnerEmail ?? undefined }]))
      setAttendeeResponses(prefill.attendees ?? [])
      setSfSelection(null)
      setPrefillWarnings(warnings)
      // Only run the local rule matcher when the suggestion didn't
      // already give us one — otherwise the two classifiers race and
      // the card can display a different type than the drawer.
      if (!prefill.activityTypeId) {
        suggestActivityType(prefill.title)
      } else {
        setTypeSuggested(true)
        setSuggestionSource('keyword')
      }
    } else {
      if (sameInit) return // don't clobber user edits when weekEvents refetches
      const now = format(new Date(), "yyyy-MM-dd'T'HH:mm")
      const endDefault = format(new Date(Date.now() + 60 * 60 * 1000), "yyyy-MM-dd'T'HH:mm")
      setForm({
        title: '',
        activityTypeId: activityTypes[0]?.id ?? '',
        subtypeId: null,
        meetingTypeReason: '',
        marketingEventName: '',
        isPrivateMeeting: false,
        startDatetime: now,
        endDatetime: endDefault,
        effortHours: '1.00',
        notes: '',
        descriptionBody: '',
        locationMode: 'remote',
        meetingOwner: '',
        meetingOwnerEmail: null,
        attendees: [],
        acv: '',
        incidentalTransportation: '',
        incidentalLodging: '',
        incidentalFood: '',
        incidentalCurrency: '',
        salesStage: null,
        forecastCategory: null,
        oppAmount: null,
        oppCloseDate: null,
        crmRelatedType: null,
        crmRelatedId: null,
        crmRelatedName: null,
        outlookEventId: '',
      })
      setAttendeesText('')
      setMeetingOwnerText('')
      setAttendeeResponses([])
      setSfSelection(null)
      setTypeSuggested(false)
      setPrefillWarnings([])
    }
    setError(null)
    // v1.91.0: include weekEvents so the editActivity branch re-runs once
    // the calendar hook resolves. Without this, opening Edit before
    // /api/outlook/calendar responds runs the fallback against `undefined`,
    // sets blank fields, and never re-hydrates when data lands.
  }, [open, editActivity, prefill, weekEvents])

  async function suggestActivityType(title: string, body?: string) {
    const res = await api.post<{
      activityTypeId: string | null
      activityTypeName: string | null
      confidence: number
      source: 'keyword' | 'ai' | 'none'
    }>('/api/ai/classify', { teamId, subject: title, body })
    const suggestion = res.data
    if (!suggestion || !suggestion.activityTypeId || suggestion.source === 'none') return
    const match = activityTypes.find((t) => t.id === suggestion.activityTypeId)
    if (!match) return
    setForm((f) => ({ ...f, activityTypeId: match.id }))
    setTypeSuggested(true)
    setSuggestionSource(suggestion.source === 'ai' ? 'ai' : 'keyword')
  }

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setDirty(true)
    setForm((f) => {
      const next = { ...f, [field]: value }
      // v1.256.0: a Subtype belongs to exactly one Activity Type — clear a
      // stale pick when the type itself changes, same as clearing the
      // "suggested" badge below.
      if (field === 'activityTypeId') {
        next.subtypeId = null
        // v1.257.0: meetingTypeReason is only ever collected for Meeting —
        // clear it when switching away so a reason typed in while Meeting
        // was selected can't silently ride along on a different type.
        const newType = activityTypes.find((at) => at.id === next.activityTypeId)
        if (newType?.name !== 'Meeting') next.meetingTypeReason = ''
        // v1.334.0: same clearing rule, for Marketing's Event Name field.
        if (newType?.name !== 'Marketing') next.marketingEventName = ''
      }
      if (field === 'startDatetime') {
        // Preserve the current duration when the user shifts start —
        // move end by the same delta so 7:00–7:30 stays 30 minutes when
        // start becomes 8:00 (end becomes 8:30). Effort hours don't
        // change on this branch.
        const prevStart = new Date(f.startDatetime)
        const newStart = new Date(next.startDatetime)
        const prevEnd = new Date(f.endDatetime)
        if (!Number.isNaN(prevStart.getTime()) && !Number.isNaN(newStart.getTime()) && !Number.isNaN(prevEnd.getTime())) {
          const deltaMs = newStart.getTime() - prevStart.getTime()
          const shiftedEnd = new Date(prevEnd.getTime() + deltaMs)
          // datetime-local format: YYYY-MM-DDTHH:mm — strip seconds/ms.
          const pad = (n: number) => String(n).padStart(2, '0')
          next.endDatetime = `${shiftedEnd.getFullYear()}-${pad(shiftedEnd.getMonth() + 1)}-${pad(shiftedEnd.getDate())}T${pad(shiftedEnd.getHours())}:${pad(shiftedEnd.getMinutes())}`
        }
        next.effortHours = computeEffortHours(next.startDatetime, next.endDatetime)
      } else if (field === 'endDatetime') {
        // Editing end recomputes effort as before.
        next.effortHours = computeEffortHours(next.startDatetime, next.endDatetime)
      } else if (field === 'effortHours') {
        // Editing effort hours pushes the end time to start + hours so
        // the calendar block reflects the entered duration.
        const start = new Date(next.startDatetime)
        const hours = Number(next.effortHours)
        if (!Number.isNaN(start.getTime()) && Number.isFinite(hours) && hours > 0) {
          const shiftedEnd = new Date(start.getTime() + hours * 60 * 60 * 1000)
          const pad = (n: number) => String(n).padStart(2, '0')
          next.endDatetime = `${shiftedEnd.getFullYear()}-${pad(shiftedEnd.getMonth() + 1)}-${pad(shiftedEnd.getDate())}T${pad(shiftedEnd.getHours())}:${pad(shiftedEnd.getMinutes())}`
        }
      }
      return next
    })
    if (field === 'activityTypeId') {
      setTypeSuggested(false)
      setSuggestionSource(null)
    }
  }

  async function handleSave(status: 'draft' | 'submitted') {
    // v1.335.0: belt-and-suspenders for the Save/Submit buttons' own
    // `disabled={endBeforeStart}` below — this function is also reachable
    // via the form's native onSubmit (Enter key inside a text input), which
    // doesn't go through the button's disabled state.
    if (endBeforeStart) {
      setError(t('activity.form.end_before_start_error', 'End time must be after start time.'))
      return
    }
    if (productsMissing) {
      setError(t('activity.form.products_required_error', 'Select at least one Product.'))
      return
    }
    if (subtypeMissing) {
      setError(t('activity.form.subtype_required_error', 'Select a Subtype.'))
      return
    }
    // v1.157.0: when an opted-in user submits a NEW activity that isn't tied to
    // an existing Outlook meeting, it will create a fresh event on their
    // calendar. Confirm first so the write isn't a surprise. Only for the Log
    // Activity drawer's Submit — not drafts (no write yet), edits, calendar
    // pre-fills, or the Suggested-card Approve path (which never calls this).
    if (status === 'submitted' && !editActivity && !form.outlookEventId && currentUser?.outlookWritebackEnabled) {
      const proceed = window.confirm(t('activity.outlook_writeback_confirm', 'This activity isn’t on your Outlook calendar. Saving it will create a new event there. Continue?'))
      if (!proceed) return
    }
    setSaving(true)
    setError(null)
    const payload = {
      teamId,
      title: form.title,
      activityTypeId: form.activityTypeId,
      subtypeId: form.subtypeId,
      meetingTypeReason: form.meetingTypeReason.trim() || undefined,
      marketingEventName: form.marketingEventName.trim() || undefined,
      isPrivateMeeting: form.isPrivateMeeting,
      startDatetime: localInputInTZToIso(form.startDatetime, userTz),
      endDatetime: localInputInTZToIso(form.endDatetime, userTz),
      effortHours: Number(form.effortHours),
      notes: form.notes || undefined,
      descriptionBody: form.descriptionBody || undefined,
      locationMode: form.locationMode,
      meetingOwner: form.meetingOwner || undefined,
      meetingOwnerEmail: form.meetingOwnerEmail || undefined,
      attendees: form.attendees.length > 0 ? form.attendees : undefined,
      acv: sfSelection?.type === 'Opportunity' && form.acv.trim() !== '' ? Number(form.acv) : null,
      // Direct/travel costs only apply to On-site activities; Remote clears them.
      costTransportation: form.locationMode === 'onsite' && form.incidentalTransportation.trim() !== '' ? Number(form.incidentalTransportation) : null,
      costLodging: form.locationMode === 'onsite' && form.incidentalLodging.trim() !== '' ? Number(form.incidentalLodging) : null,
      costFood: form.locationMode === 'onsite' && form.incidentalFood.trim() !== '' ? Number(form.incidentalFood) : null,
      incidentalCurrency: form.locationMode === 'onsite' && (form.incidentalTransportation.trim() !== '' || form.incidentalLodging.trim() !== '' || form.incidentalFood.trim() !== '') ? (form.incidentalCurrency || prefCurrency) : null,
      salesStage: form.salesStage ?? null,
      forecastCategory: form.forecastCategory ?? null,
      oppAmount: form.oppAmount !== null && form.oppAmount !== '' ? Number(form.oppAmount) : null,
      oppCloseDate: form.oppCloseDate ?? null,
      productIds,
      tickets,
      outlookEventId: form.outlookEventId || undefined,
      // Route the selection into either the What bucket
      // (Opportunity/Account/Campaign — all valid SF WhatId targets on
      // Event/Task) or the Who bucket (Contact/Lead). Whichever set
      // doesn't match is explicitly nulled so switching selection
      // cleans up prior linkage.
      crmWhatId: sfSelection && (sfSelection.type === 'Opportunity' || sfSelection.type === 'Account' || sfSelection.type === 'Campaign') ? sfSelection.id : null,
      crmWhatType: sfSelection && (sfSelection.type === 'Opportunity' || sfSelection.type === 'Account' || sfSelection.type === 'Campaign') ? sfSelection.type : null,
      crmWhatName: sfSelection && (sfSelection.type === 'Opportunity' || sfSelection.type === 'Account' || sfSelection.type === 'Campaign') ? sfSelection.name : null,
      // v1.97.0: snapshot the linked Opportunity's Account name + current
      // Assigned SE so the card can render them without a live SF read.
      // For Opportunity links, extras.accountName comes from SfSearch;
      // Account links pass through their own id/name as the account.
      crmAccountId: sfSelection?.type === 'Opportunity'
        ? (sfSelection.extra?.accountId ?? null)
        : sfSelection?.type === 'Account'
          ? sfSelection.id
          : null,
      crmAccountName: sfSelection?.type === 'Opportunity'
        ? (sfSelection.extra?.accountName ?? null)
        : sfSelection?.type === 'Account'
          ? sfSelection.name
          : null,
      crmAssignedSeName: sfSelection?.type === 'Opportunity' ? (assignedSe.userName ?? null) : null,
      crmWhoId: sfSelection && (sfSelection.type === 'Contact' || sfSelection.type === 'Lead') ? sfSelection.id : null,
      crmWhoType: sfSelection && (sfSelection.type === 'Contact' || sfSelection.type === 'Lead') ? sfSelection.type : null,
      crmWhoName: sfSelection && (sfSelection.type === 'Contact' || sfSelection.type === 'Lead') ? sfSelection.name : null,
      // v1.67.0: SF child link populated by per-activity-type Extras
      // (e.g. Eval Work → Evaluation__c). Nulled when the SE clears
      // the picker or the parent Opp is unlinked.
      crmRelatedType: sfSelection?.type === 'Opportunity' ? form.crmRelatedType : null,
      crmRelatedId: sfSelection?.type === 'Opportunity' ? form.crmRelatedId : null,
      crmRelatedName: sfSelection?.type === 'Opportunity' ? form.crmRelatedName : null,
      status,
    }

    const res = editActivity
      ? await api.patch<Activity>(`/api/activities/${editActivity.id}`, payload)
      : await api.post<Activity>('/api/activities', payload)

    if (res.error) {
      setError(res.error)
      setSaving(false)
      return
    }

    // If submitting and no status field in create payload, patch status
    if (!editActivity && status === 'submitted' && res.data) {
      await api.patch(`/api/activities/${res.data.id}`, { status: 'submitted' })
    }

    // Notes are also a first-class feature — every save with non-empty
    // notes text that differs from the previous DB value appends a fresh
    // timestamped entry to /api/notes so the history is preserved. Legacy
    // activities.notes still updates via the main PATCH above; this side
    // effect just makes sure the new stream stays in sync.
    const priorNotes = editActivity?.notes ?? ''
    const nextNotes = form.notes.trim()
    if (nextNotes && nextNotes !== priorNotes.trim()) {
      const activityId = editActivity?.id ?? res.data?.id
      if (activityId) {
        const noteRes = await api.post<{ id: string }>(`/api/notes`, { activityId, body: nextNotes })
        if (noteRes.error) {
          // eslint-disable-next-line no-console
          console.warn('[notes] append failed:', noteRes.error)
        }

        // Push that same note to Salesforce as a ContentNote on the
        // Opportunity and/or Account — another secondary, non-blocking
        // write layered on top of the note above. Create-mode only (see
        // postToOppNotes/postToAcctNotes comment) — edit mode's identical
        // checkboxes live in NotesPanel's own submitNew().
        const pushTargets = [
          postToOppNotes && oppNotesPushTarget ? oppNotesPushTarget : null,
          postToAcctNotes && acctNotesPushTarget ? acctNotesPushTarget : null,
        ].filter((t): t is NonNullable<typeof t> => t !== null)
        if (pushTargets.length > 0 && noteRes.data) {
          const pushRes = await api.post(`/api/notes/${noteRes.data.id}/push`, { targets: pushTargets })
          if (pushRes.error) {
            // eslint-disable-next-line no-console
            console.warn('[notes-push] push failed:', pushRes.error)
            setSfNotesPushError(pushRes.error)
          } else {
            setPostToOppNotes(false)
            setPostToAcctNotes(false)
            setSfNotesPushError(null)
          }
        }
      }
    }

    // Engineer Notes prepend-update — a secondary, non-blocking write. The
    // activity save above has already succeeded and must not be undone by
    // a Salesforce failure here; any error is surfaced without rolling
    // back or re-showing the form as failed.
    if (postToEngineerNotes && crmProjects && form.crmRelatedType && form.crmRelatedId && nextNotes) {
      const prependRes = await api.post(`${crmApiBase}/field-prepend`, {
        teamId,
        sobject: form.crmRelatedType,
        appField: 'eval_engineer_notes',
        recordId: form.crmRelatedId,
        text: nextNotes,
      })
      if (prependRes.error) {
        // eslint-disable-next-line no-console
        console.warn('[engineer-notes] prepend failed:', prependRes.error)
        setEngineerNotesError(prependRes.error)
      } else {
        setPostToEngineerNotes(false)
      }
    }

    // Assigned SE write-back — only fires when the picker's value actually
    // changed and we're still on an Opportunity. Failures here are non-fatal
    // to the activity save (the record is already persisted at this point).
    if (
      sfSelection?.type === 'Opportunity'
      && assignedSe.userId !== initialAssignedSe.userId
      && assignedSeMeta.configured && assignedSeMeta.canWrite
    ) {
      const seRes = await api.patch(`${crmApiBase}/opportunities/${encodeURIComponent(sfSelection.id)}/assigned-se`, { userId: assignedSe.userId, userName: assignedSe.userName, teamId })
      if (seRes.error) {
        // eslint-disable-next-line no-console
        console.warn('[assigned-se] update failed:', seRes.error)
      } else {
        setInitialAssignedSe(assignedSe)
      }
    }

    setSaving(false)
    onSaved()
    onClose()
  }

  // v1.370.0: past the 90-day edit window (§7) — App Admins are exempt, so
  // this alone doesn't decide read-only status; see isReadOnly below.
  const isPastEditWindow =
    !!editActivity &&
    (Date.now() - new Date(editActivity.createdAt).getTime()) / (1000 * 60 * 60 * 24) > 90

  const isReadOnly = isPastEditWindow && !currentUser?.isAppAdmin

  // v1.335.0: an activity created FROM an existing Outlook meeting carries
  // outlookEventId — the calendar event is the source of truth for when the
  // meeting actually happened, so Start/End/Effort Hours are locked to
  // whatever synced from Outlook rather than allowing a hand-edit that would
  // silently drift from the real meeting. A manually-created activity (no
  // linked Outlook event) keeps these fully editable, same as before.
  const isOutlookLinked = !!form.outlookEventId
  const datetimeLocked = isReadOnly || isOutlookLinked

  // v1.335.0: computeEffortHours() clamps a negative duration to "0.00" with
  // no visual signal — an End Time edited to land at or before Start Time
  // (e.g. the datetime-local picker rolling to the wrong AM/PM, or a same-day
  // edit that should have crossed midnight) silently produced a real,
  // savable "0.0h" activity with no indication anything was wrong. Surfacing
  // this explicitly, and blocking Save while it holds, closes that gap
  // without touching the Start-edit "shift the whole block" or Effort-edit
  // "resize from Start" behavior above — both already produce a valid range
  // on their own and don't need this guard.
  const endBeforeStart =
    !datetimeLocked &&
    !!form.startDatetime &&
    !!form.endDatetime &&
    new Date(form.endDatetime).getTime() <= new Date(form.startDatetime).getTime()

  // v1.335.0: Products and Subtype are both required independently — but
  // only when the field is actually reachable. A team with zero configured
  // Products, or with subtypesEnabled off (or the current Activity Type
  // having no Subtypes at all), renders no picker at all (§7/§19b) — making
  // the requirement unconditional would permanently block Save/Submit for
  // every activity on that team with nothing the user could ever select to
  // satisfy it. Same reasoning `showSubtypePicker` itself already applies.
  const productsRequired = teamProducts.length > 0
  const productsMissing = !isReadOnly && productsRequired && productIds.length === 0
  const subtypeRequired = showSubtypePicker
  const subtypeMissing = !isReadOnly && subtypeRequired && !form.subtypeId
  // Save/Submit button tooltip when blocked by validation — first one that
  // applies, matching handleSave()'s own check order above.
  const validationBlockedTitle = endBeforeStart
    ? t('activity.form.end_before_start_error', 'End time must be after start time.')
    : productsMissing
      ? t('activity.form.products_required_error', 'Select at least one Product.')
      : subtypeMissing
        ? t('activity.form.subtype_required_error', 'Select a Subtype.')
        : undefined

  const title = editActivity ? editActivity.title : prefill ? t('activity.logActivity') : t('activity.logActivity')

  // Incidental (Direct) cost helpers — capture/display in the user's currency.
  const incidentalCurrencyCode = form.incidentalCurrency || prefCurrency
  const incidentalTotal =
    Number(form.incidentalTransportation || 0) +
    Number(form.incidentalLodging || 0) +
    Number(form.incidentalFood || 0)
  const fmtIncidental = (n: number): string => {
    try {
      return n.toLocaleString(undefined, { style: 'currency', currency: incidentalCurrencyCode, maximumFractionDigits: 2 })
    } catch {
      return `${incidentalCurrencyCode} ${n.toFixed(2)}`
    }
  }

  // On a narrow screen the tab row scrolls sideways: keep the open tab visible.
  const tabRowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    tabRowRef.current?.querySelector('[data-tab-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTab, open, transcriptsEnabled, aiNotesEnabled, assessmentsVisible])

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      title={title}
      titleIcon={CalendarPlus}
      // v1.460.0: wider than the default max-w-xl so Edit / Notes / Sync
      // History / Transcripts / AI Notes fit on one line.
      className="max-w-[52rem]"
      headerActions={editActivity ? (
        <button
          type="button"
          onClick={() => setDeletePromptOpen(true)}
          className="rounded p-2 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          title={t('activity.form.delete_button', 'Delete activity')}
          aria-label={t('activity.form.delete_button', 'Delete activity')}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    >
      {editActivity && (
        <div ref={tabRowRef} className="mb-3 flex gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap shadow-[inset_0_-1px_0_var(--color-gray-200)] [scrollbar-width:none] dark:shadow-[inset_0_-1px_0_var(--color-gray-700)] [&::-webkit-scrollbar]:hidden">
          {/* v1.460.1: the gray baseline is an inset shadow, not a border the
              tabs overlap with -mb-px; that 1px overlap made the scrolling row
              show a vertical scrollbar. The scrollbar is hidden; the row still
              scrolls sideways on a narrow screen. */}
          <button
            type="button"
            onClick={() => setActiveTab('edit')}
            data-tab-active={activeTab === 'edit' ? 'true' : undefined}
            className={`shrink-0 px-3 py-1.5 text-sm border-b-2 ${activeTab === 'edit' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
          >
            <span className="inline-flex items-center gap-1">
              <SquarePen className="h-3.5 w-3.5" />
              {t('activity.form.tab_edit', 'Edit')}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notes')}
            data-tab-active={activeTab === 'notes' ? 'true' : undefined}
            className={`shrink-0 px-3 py-1.5 text-sm border-b-2 ${activeTab === 'notes' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
          >
            <span className="inline-flex items-center gap-1">
              <StickyNote className="h-3.5 w-3.5" />
              {t('activity.form.tab_notes', 'Notes')} ({editActivity.notesCount ?? 0})
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('sync')}
            data-tab-active={activeTab === 'sync' ? 'true' : undefined}
            className={`shrink-0 px-3 py-1.5 text-sm border-b-2 ${activeTab === 'sync' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
          >
            <span className="inline-flex items-center gap-1">
              <CloudSync className="h-3.5 w-3.5" />
              {t('activity.form.tab_sync', 'Sync History')} ({syncCount ?? 0})
            </span>
          </button>
          {transcriptsEnabled && (
            <button
              type="button"
              onClick={() => setActiveTab('transcripts')}
              data-tab-active={activeTab === 'transcripts' ? 'true' : undefined}
              className={`shrink-0 px-3 py-1.5 text-sm border-b-2 ${activeTab === 'transcripts' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
            >
              <span className="inline-flex items-center gap-1">
                <MessageCircleText className="h-3.5 w-3.5" />
                {t('activity.form.tab_transcripts')} ({transcriptCount ?? 0})
              </span>
            </button>
          )}
          {aiNotesEnabled && (
            <button
              type="button"
              onClick={() => setActiveTab('ai_notes')}
              data-tab-active={activeTab === 'ai_notes' ? 'true' : undefined}
              className={`shrink-0 px-3 py-1.5 text-sm border-b-2 ${activeTab === 'ai_notes' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
            >
              <span className="inline-flex items-center gap-1">
                <Sparkles className="h-3.5 w-3.5" />
                {t('activity.form.tab_ai_notes')} ({aiNotesCount ?? 0})
              </span>
            </button>
          )}
          {assessmentsVisible && (
            <button
              type="button"
              onClick={() => setActiveTab('assessments')}
              data-tab-active={activeTab === 'assessments' ? 'true' : undefined}
              className={`shrink-0 px-3 py-1.5 text-sm border-b-2 ${activeTab === 'assessments' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
            >
              <span className="inline-flex items-center gap-1">
                <ClipboardCheck className="h-3.5 w-3.5" />
                {t('activity.form.tab_assessments')} ({assessmentsCount ?? 0})
              </span>
            </button>
          )}
        </div>
      )}
      {editActivity && activeTab === 'notes' ? (
        <NotesPanel
          activityId={editActivity.id}
          teamId={teamId}
          activityTitle={editActivity.title}
          activityTypeIcon={editActivity.activityTypeIcon}
          activityTypeColor={editActivity.activityTypeColor}
          activityTypeName={editActivity.activityTypeName}
          crmWhatId={editActivity.crmWhatId}
          crmWhatType={editActivity.crmWhatType}
          crmWhatName={editActivity.crmWhatName}
          crmWhoId={editActivity.crmWhoId}
          crmWhoType={editActivity.crmWhoType}
          crmWhoName={editActivity.crmWhoName}
          crmRelatedType={editActivity.crmRelatedType}
          crmRelatedId={editActivity.crmRelatedId}
          crmAccountId={editActivity.crmAccountId}
          crmAccountName={editActivity.crmAccountName}
          disabled={isReadOnly}
          onReload={onSaved}
        />
      ) : editActivity && activeTab === 'sync' ? (
        <SyncHistoryTab activityId={editActivity.id} onCountChange={setSyncCount} />
      ) : editActivity && activeTab === 'transcripts' && transcriptsEnabled ? (
        <TranscriptsTab activityId={editActivity.id} activityStart={editActivity.startDatetime} onCountChange={setTranscriptCount} />
      ) : editActivity && activeTab === 'ai_notes' && aiNotesEnabled ? (
        <AiNotesTab activityId={editActivity.id} onCountChange={setAiNotesCount} onNotesChanged={onSaved} />
      ) : editActivity && activeTab === 'assessments' && assessmentsVisible ? (
        <AiAssessmentsTab activityId={editActivity.id} onCountChange={setAssessmentsCount} />
      ) : (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => { e.preventDefault(); handleSave('submitted') }}
      >
        <p className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          {(() => {
            // v1.369.0: the literal "*" inside the translated sentence used to
            // render as plain gray text — only the separate decorative star
            // that used to sit in front of the sentence was actually red, so
            // the note read as "the asterisk marking required fields isn't
            // itself highlighted." Split on the real "*" in the (possibly
            // translated) string and wrap just that character, so every
            // locale's own asterisk position gets the red styling with no
            // hardcoded English string position.
            const note = t('activity.form.required_field_note', 'Fields marked with * are required.')
            const idx = note.indexOf('*')
            if (idx === -1) return note
            return (
              <>
                {note.slice(0, idx)}
                <span className="text-red-500" aria-hidden="true">*</span>
                {note.slice(idx + 1)}
              </>
            )
          })()}
        </p>

        {isPastEditWindow && (
          <p className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <UserLock className="h-3.5 w-3.5 shrink-0" />
            {isReadOnly
              ? t(
                  'activity.form.past_edit_window_readonly',
                  "This activity is more than 90 days old and can no longer be edited. Only an App Admin can edit an activity of any age.",
                )
              : t(
                  'activity.form.past_edit_window_admin_override',
                  "This activity is more than 90 days old and would normally be read-only, but you can edit it because you're an App Admin.",
                )}
          </p>
        )}

        {isNonActivity && (
          <div className="flex items-start gap-2 rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-sm text-gray-100">
            <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-200" />
            <div className="flex flex-1 flex-col gap-1">
              <span className="font-semibold">{t('activity.non_activity.form_banner_title', 'This meeting is marked as Non-Activity')}</span>
              <span className="text-xs text-gray-200">{t('activity.non_activity.form_banner_body', 'Mark it as an Activity to approve and save it as a logged activity.')}</span>
            </div>
            {onUnmarkNonActivity && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onUnmarkNonActivity}
                className="shrink-0 text-gray-100 hover:bg-gray-500 hover:text-white"
              >
                {t('activity.non_activity.unmark', 'Mark as Activity')}
              </Button>
            )}
          </div>
        )}

        {prefillWarnings.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex flex-col gap-1">
              {prefillWarnings.map((w) => (
                <span key={w}>{t(`activity.warnings.${w}`)}</span>
              ))}
              <span className="text-xs text-amber-700 dark:text-amber-300">{t('activity.warnings.adjust_hours')}</span>
            </div>
          </div>
        )}

        {/* Template picker — hidden while editing an existing activity */}
        {!editActivity && templates.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="template" className="inline-flex items-center gap-1.5">
              <Bookmark className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              {t('activity.form.template_label')}
            </Label>
            <div className="relative">
              <Bookmark className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-blue-600 dark:text-blue-400" />
              <select
                id="template"
                onChange={(e) => { if (e.target.value) applyTemplate(e.target.value); e.target.value = '' }}
                className="h-9 w-full rounded-md border border-gray-300 bg-white pl-7 pr-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                defaultValue=""
              >
                <option value="" disabled>{t('activity.form.template_placeholder')}</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{`\u{1F516} ${tpl.name}`}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Title */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title" className="inline-flex items-center gap-1.5">
            <Type className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.title_label')}
            <span className="text-red-500" aria-hidden="true">*</span>
          </Label>
          <Input
            id="title"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder={t('activity.form.title_placeholder')}
            disabled={isReadOnly}
            required
          />
        </div>

        {/* Activity Type + Subtype — the grid's column count itself toggles
            (rather than col-span on Activity Type) so there's no orphaned
            empty second column when Subtype is hidden. */}
        <div className={cn('grid gap-3', showSubtypePicker ? 'grid-cols-2' : 'grid-cols-1')}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="activityType" className="inline-flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
                {t('activity.form.type_label')}
                <span className="text-red-500" aria-hidden="true">*</span>
              </Label>
              {typeSuggested && (
                <Badge variant="default" className="gap-1">
                  <Sparkles className="h-3 w-3" />
                  {suggestionSource === 'ai'
                    ? t('activity.suggestion.ai_suggested')
                    : t('activity.suggestion.keyword_suggested')}
                </Badge>
              )}
              {!typeSuggested && editActivity && (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  {t('activity.suggestion.confirmed')}
                </Badge>
              )}
            </div>
            <ActivityTypePicker
              id="activityType"
              value={form.activityTypeId}
              options={activityTypes}
              onChange={(v) => set('activityTypeId', v)}
              disabled={isReadOnly}
            />
            {typeSuggested && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('activity.suggestion.confirm_type')} — {t('activity.suggestion.change_type')}
              </p>
            )}
          </div>
          {showSubtypePicker && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activitySubtype" className="inline-flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
                {t('activity.form.subtype_label', 'Subtype')}
                <span className="text-red-500" aria-hidden="true">*</span>
              </Label>
              <Select
                id="activitySubtype"
                value={form.subtypeId ?? ''}
                onChange={(e) => set('subtypeId', e.target.value || null)}
                disabled={isReadOnly}
                aria-invalid={subtypeMissing}
                className={subtypeMissing ? 'border-red-500 focus-visible:ring-red-500 dark:border-red-500' : undefined}
              >
                <option value="">{t('activity.form.subtype_none', '— None —')}</option>
                {currentSubtypes.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
              {subtypeMissing && (
                <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {t('activity.form.subtype_required_error', 'Select a Subtype.')}
                </p>
              )}
            </div>
          )}
        </div>

        {/* v1.337.1 / v1.339.0: Support Tickets — directly under Activity
            Type/Subtype (renders the moment a type with a ticket_picker
            Extra configured is chosen) and above Start/End Time, rather
            than down by the Salesforce Link section. A ticket picker only
            needs an Account, not an Opportunity link, and doesn't depend on
            the SF Link field being filled in first. */}
        <TicketExtrasPanel
          teamId={teamId}
          activityTypeId={form.activityTypeId}
          crmAccountId={derivedSfAccountId}
          sfInstanceUrl={crmStatus?.instanceUrl ?? null}
          tickets={tickets}
          onTicketsChange={(next) => { setTickets(next); setDirty(true) }}
          disabled={isReadOnly}
          refreshing={ticketsRefreshing}
        />

        {isMeetingType && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meetingTypeReason" className="inline-flex items-center gap-1.5">
              <MessageCircleQuestion className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              {t('activity.form.meeting_reason_label', 'Why Meeting?')}
            </Label>
            <Textarea
              id="meetingTypeReason"
              rows={2}
              value={form.meetingTypeReason}
              onChange={(e) => set('meetingTypeReason', e.target.value)}
              placeholder={t('activity.form.meeting_reason_placeholder', 'What was this meeting about?')}
              disabled={isReadOnly}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('activity.form.meeting_reason_hint', 'Optional — helps us understand whether we need a more specific activity type.')}
            </p>
          </div>
        )}

        {isMarketingType && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="marketingEventName" className="inline-flex items-center gap-1.5">
              <Megaphone className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              {t('activity.form.marketing_event_name_label', 'Event Name')}
            </Label>
            <Input
              id="marketingEventName"
              value={form.marketingEventName}
              onChange={(e) => set('marketingEventName', e.target.value)}
              placeholder={t('activity.form.marketing_event_name_placeholder', 'e.g. Innovate Security Summit, Black Hat')}
              disabled={isReadOnly}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('activity.form.marketing_event_name_hint', { context: crmCtx, defaultValue: 'Optional — ImpactIQ only, not sent to Salesforce.' })}
            </p>
          </div>
        )}

        {/* Datetime */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="start" className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              {t('activity.form.start_label')}
              <span className="text-red-500" aria-hidden="true">*</span>
            </Label>
            <Input
              id="start"
              type="datetime-local"
              value={form.startDatetime}
              onChange={(e) => set('startDatetime', e.target.value)}
              disabled={datetimeLocked}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="end" className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              {t('activity.form.end_label')}
              <span className="text-red-500" aria-hidden="true">*</span>
            </Label>
            <Input
              id="end"
              type="datetime-local"
              value={form.endDatetime}
              onChange={(e) => set('endDatetime', e.target.value)}
              disabled={datetimeLocked}
              required
              aria-invalid={endBeforeStart}
              className={endBeforeStart ? 'border-red-500 focus-visible:ring-red-500 dark:border-red-500' : undefined}
            />
          </div>
        </div>
        {endBeforeStart && (
          <p className="-mt-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {t('activity.form.end_before_start_error', 'End time must be after start time.')}
          </p>
        )}

        {/* Effort Hours */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="effortHours" className="inline-flex items-center gap-1.5">
            <Timer className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.effort_label')}
            <span className="text-red-500" aria-hidden="true">*</span>
          </Label>
          <Input
            id="effortHours"
            type="number"
            min="0"
            max="24"
            step="0.25"
            value={form.effortHours}
            onChange={(e) => set('effortHours', e.target.value)}
            disabled={datetimeLocked}
            required
          />
          {isOutlookLinked && !isReadOnly && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('activity.form.outlook_locked_hint', 'Locked to the linked Outlook meeting’s time.')}
            </p>
          )}
        </div>

        {/* SF Link */}
        <div className="flex flex-col gap-1.5">
          <Label className="flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.sf_link_label', { context: crmCtx })}
            <SfRelationshipHelp />
            <label className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-gray-500 dark:text-gray-400">
              <input
                type="checkbox"
                checked={sfShowClosedOpps}
                onChange={(e) => setSfShowClosedOpps(e.target.checked)}
                disabled={isReadOnly}
                className="h-3 w-3 rounded border-gray-300"
              />
              {t('activity.form.sf_show_closed', 'Show Closed')}
            </label>
          </Label>
          <SfSearch
            value={sfSelection}
            onChange={(sel) => { applySfSelection(sel); setDirty(true) }}
            disabled={isReadOnly}
            attendeeEmails={form.attendees.map((a) => a.email ?? '').filter(Boolean)}
            showClosed={sfShowClosedOpps}
            teamId={teamId}
          />
          <AttendeeSuggestions
            attendees={form.attendees}
            disabled={isReadOnly}
            onPick={(sel) => { applySfSelection(sel); setDirty(true) }}
          />
          {sfLinkStatusChecking && (
            <p className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('activity.sf_link_status.checking', { defaultValue: 'Checking Salesforce…', context: crmCtx })}
            </p>
          )}
          {!sfLinkStatusChecking && sfLinkMoved && (
            <p className="flex items-center gap-1.5 text-[11px] text-sky-700 dark:text-sky-300">
              <GitMerge className="h-3 w-3 shrink-0" />
              {t('activity.sf_link_status.merged_note', { defaultValue: 'A linked record was merged into another in the CRM. The link now points to the surviving record.', context: crmCtx })}
            </p>
          )}
          {!sfLinkStatusChecking && (sfLinkStatus?.crmWhatDeleted || sfLinkStatus?.crmWhoDeleted || sfLinkStatus?.crmRelatedDeleted) && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p>{t('activity.sf_link_status.deleted_warning', { defaultValue: 'One or more linked Salesforce records could not be found — they may have been deleted.', context: crmCtx })}</p>
                <ul className="mt-1 list-disc pl-4">
                  {sfLinkStatus?.crmWhatDeleted && <li>{t('activity.sf_link_status.what', { defaultValue: 'What (Account/Opportunity/Campaign)', context: crmCtx })}</li>}
                  {sfLinkStatus?.crmWhoDeleted && <li>{t('activity.sf_link_status.who', { defaultValue: 'Who (Contact/Lead)', context: crmCtx })}</li>}
                  {sfLinkStatus?.crmRelatedDeleted && <li>{t('activity.sf_link_status.related', { defaultValue: 'Related record', context: crmCtx })}</li>}
                </ul>
              </div>
            </div>
          )}
        </div>

        {sfSelection?.type === 'Opportunity' && (
          <>
          {/* v1.293.0: moved above the $ Total Business block so it sits
              directly under the Salesforce Link section it describes,
              instead of trailing below the money fields. Chevron expands
              into the Total Bookings New Business / Renewals breakdown,
              fetched live (refresh on open) via the same preview endpoint
              the hover popover uses. */}
          {(form.salesStage || form.forecastCategory || form.oppCloseDate) && (
            <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-1 flex-wrap gap-2">
                  {form.salesStage && (
                    <span><span className="text-gray-400">{t('activity.form.sales_stage_label', 'Sales Stage')}:</span> <span className="font-medium">{form.salesStage}</span></span>
                  )}
                  {form.forecastCategory && (
                    <span><span className="text-gray-400">{t('activity.form.forecast_category_label', 'Forecast')}:</span> <span className="font-medium">{form.forecastCategory}</span></span>
                  )}
                  {form.oppCloseDate && (
                    <span><span className="text-gray-400">{t('activity.form.opp_close_date_label', 'Close Date')}:</span> <span className="font-medium">{form.oppCloseDate}</span></span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void toggleSfBusinessExpanded()}
                  className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  aria-label={sfBusinessExpanded ? t('activity.form.sf_business_collapse', 'Hide business breakdown') : t('activity.form.sf_business_expand', 'Show business breakdown')}
                  title={sfBusinessExpanded ? t('activity.form.sf_business_collapse', 'Hide business breakdown') : t('activity.form.sf_business_expand', 'Show business breakdown')}
                >
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', sfBusinessExpanded && 'rotate-180')} />
                </button>
              </div>
              {sfBusinessExpanded && (
                <div className="border-t border-gray-200 pt-1.5 dark:border-gray-700">
                  {sfBusinessLoading ? (
                    <div className="flex items-center gap-1.5 py-1 text-gray-400 dark:text-gray-500">
                      <Spinner className="h-3 w-3" />
                      {t('common.loading')}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <BizNumberBox label={t('activity.form.new_business_acv_label', 'New Business ACV')} tip={t('activity.form.new_business_acv_tip', 'Total Bookings New License ACV: License/1st Year')} value={sfBusinessNumbers?.newBusinessAcv ?? null} />
                      <BizNumberBox label={t('activity.form.renewal_acv_label', 'Renewals ACV')} tip={t('activity.form.renewal_acv_tip', 'Total Bookings Renewal ACV: License/1st Year')} value={sfBusinessNumbers?.renewalAcv ?? null} />
                      <BizNumberBox label={t('activity.form.new_business_tcv_label', 'New Business TCV')} tip={t('activity.form.new_business_tcv_tip', 'Total Bookings New Business TCV: License/1st Year + Multi-Years + Services')} value={sfBusinessNumbers?.newBusinessTcv ?? null} />
                      <BizNumberBox label={t('activity.form.renewal_tcv_label', 'Renewals TCV')} tip={t('activity.form.renewal_tcv_tip', 'Total Bookings Renewal TCV: License/1st Year + Multi-Years')} value={sfBusinessNumbers?.renewalTcv ?? null} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acv" className="inline-flex items-center gap-1.5">
              <DollarSign className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              {t('activity.form.acv_label')}
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col justify-center rounded border border-dashed border-gray-200 bg-gray-50 px-2 py-1 dark:border-gray-700 dark:bg-gray-800/50">
                <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('activity.form.total_acv_label', 'Total ACV (SF)')}</span>
                <input
                  id="acv"
                  type={acvFocused ? 'number' : 'text'}
                  min={acvFocused ? 0 : undefined}
                  step={acvFocused ? '0.01' : undefined}
                  inputMode="decimal"
                  value={
                    !acvFocused && form.acv !== '' && !Number.isNaN(Number(form.acv))
                      ? Number(form.acv).toLocaleString(undefined, { maximumFractionDigits: 2 })
                      : form.acv
                  }
                  onFocus={() => setAcvFocused(true)}
                  onBlur={() => setAcvFocused(false)}
                  onChange={(e) => set('acv', e.target.value)}
                  placeholder="0.00"
                  // Editable only when there's no SF Opp yet OR the activity
                  // hasn't synced. Once an Opp is linked with a known Amount
                  // OR the activity has synced, the value is locked so it
                  // reflects the SF-side truth.
                  disabled={
                    isReadOnly
                    || (!!editActivity && editActivity.crmSyncStatus === 'synced')
                    || (sfSelection?.type === 'Opportunity' && form.oppAmount != null && form.oppAmount !== '')
                  }
                  className="w-full border-0 bg-transparent p-0 font-mono text-sm text-gray-800 focus:outline-none focus:ring-0 dark:text-gray-100 disabled:opacity-60"
                />
              </div>
              <div className="flex flex-col justify-center rounded border border-dashed border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400">
                <span className="text-[10px] uppercase tracking-wide">{t('activity.form.opp_amount_label', 'Opp Amount (SF)')}</span>
                <span className="font-mono">{form.oppAmount != null && form.oppAmount !== '' ? Number(form.oppAmount).toLocaleString() : '—'}</span>
              </div>
            </div>
          </div>
          </>
        )}

        {/* v1.67.0 / v1.148.0: per-activity-type Salesforce Extras — the
            Project (Evaluation) picker renders below the Opportunity
            Info block, since it's the child-object picker for whichever
            Opportunity was just linked above. */}
        <SfExtrasPanel
          teamId={teamId}
          activityTypeId={form.activityTypeId}
          crmOppId={sfSelection?.type === 'Opportunity' ? sfSelection.id : null}
          crmOppName={sfSelection?.type === 'Opportunity' ? sfSelection.name : null}
          crmAccountId={derivedSfAccountId}
          relatedId={form.crmRelatedId}
          relatedName={form.crmRelatedName}
          onPickRelated={(sobject, id, name) => {
            // An empty id means the picker was cleared: store no link at all
            // rather than an empty-string id.
            setForm((f) => ({ ...f, crmRelatedType: id ? sobject : null, crmRelatedId: id || null, crmRelatedName: id ? name : null }))
            setDirty(true)
          }}
          disabled={isReadOnly}
        />

        {/* Products */}
        <div className="flex flex-col gap-1.5">
          <Label className="inline-flex items-center gap-1.5">
            <Package className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.products_label')}
            {productsRequired && <span className="text-red-500" aria-hidden="true">*</span>}
          </Label>
          {teamProducts.length === 0 ? (
            <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-500 dark:border-gray-600 dark:bg-gray-800/40 dark:text-gray-400">
              {t('activity.form.products_empty_hint')}
            </p>
          ) : (
            <div
              className={cn(
                'flex flex-wrap gap-1.5 rounded-md',
                productsMissing && 'outline outline-1 outline-offset-2 outline-red-500',
              )}
            >
              {teamProducts.map((p) => {
                const on = productIds.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => setProductIds((prev) => (on ? prev.filter((x) => x !== p.id) : [...prev, p.id]))}
                    className={cn(
                      'flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                      on
                        ? 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500'
                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
                    )}
                    title={p.space ?? p.name}
                  >
                    <input type="checkbox" checked={on} readOnly className="h-3 w-3" />
                    {p.iconDataUrl && <img src={p.iconDataUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />}
                    <span>{p.name}</span>
                    {p.abbreviation && <span className="text-[10px] opacity-70">({p.abbreviation})</span>}
                  </button>
                )
              })}
            </div>
          )}
          {productsMissing && (
            <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {t('activity.form.products_required_error', 'Select at least one Product.')}
            </p>
          )}
        </div>

        {/* Location mode toggle + incidental (Direct) costs */}
        <div className="flex flex-col gap-1.5">
          <Label className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.location_mode_label')}
          </Label>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex overflow-hidden rounded border border-gray-200 dark:border-gray-600 w-fit">
              {(['remote', 'onsite'] as const).map((m) => {
                const Icon = m === 'remote' ? Wifi : MapPin
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      if (isReadOnly || m === form.locationMode) return
                      if (m === 'remote') {
                        // Direct costs are travel-only (On-site). Warn before discarding them.
                        const hasCosts = incidentalTotal > 0
                        if (hasCosts && !window.confirm(t('activity.form.incidental_clear_confirm', 'Switching to Remote will clear and delete the direct (travel) costs entered for this activity. Keep it On-site if that is wrong. Continue?'))) return
                        setForm((f) => ({ ...f, locationMode: 'remote', incidentalTransportation: '', incidentalLodging: '', incidentalFood: '' }))
                        setIncidentalOpen(false)
                        return
                      }
                      // On-site: switch and open the travel-cost capture modal.
                      setForm((f) => ({ ...f, locationMode: 'onsite', incidentalCurrency: f.incidentalCurrency || prefCurrency }))
                      setIncidentalOpen(true)
                    }}
                    disabled={isReadOnly}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors',
                      form.locationMode === m
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t(`activity.form.location_mode.${m}`)}
                  </button>
                )
              })}
            </div>
            {form.locationMode === 'onsite' && (
              <button
                type="button"
                onClick={() => { if (!isReadOnly) setIncidentalOpen(true) }}
                disabled={isReadOnly}
                title={t('activity.form.incidental_costs_label', 'Incidental Costs')}
                className="inline-flex items-center gap-1.5 rounded-md border border-orange-300 bg-orange-100 px-2.5 py-1.5 text-xs font-medium text-orange-900 hover:bg-orange-200 disabled:opacity-60 dark:border-orange-800/60 dark:bg-orange-950/40 dark:text-orange-200 dark:hover:bg-orange-900/50"
              >
                <DollarSign className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
                {t('activity.form.incidental_costs_label', 'Incidental Costs')}:
                <span className="tabular-nums font-semibold">{fmtIncidental(incidentalTotal)}</span>
              </button>
            )}
          </div>
        </div>

        {/* Incidental (Direct) costs capture modal */}
        {incidentalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setIncidentalOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
                  <DollarSign className="h-4 w-4" />
                  {t('activity.form.incidental_modal_title', 'Incidental Costs')}
                </h3>
                <button type="button" onClick={() => setIncidentalOpen(false)} className="rounded px-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label={t('common.close', 'Close')}>✕</button>
              </div>
              <p className="mb-3 text-[11px] text-gray-500 dark:text-gray-400">
                {t('activity.form.incidental_currency_note', 'Enter amounts in {{currency}} (your display currency).', { currency: incidentalCurrencyCode })}
              </p>
              <div className="flex flex-col gap-3">
                {([
                  { key: 'incidentalTransportation' as const, icon: Car, label: t('activity.form.incidental_transportation', 'Transportation'), hint: t('activity.form.incidental_transportation_hint', 'Flights, cars, rentals, ride-share, taxis, mileage') },
                  { key: 'incidentalLodging' as const, icon: BedDouble, label: t('activity.form.incidental_lodging', 'Lodging'), hint: t('activity.form.incidental_lodging_hint', 'Hotels or BNB') },
                  { key: 'incidentalFood' as const, icon: Utensils, label: t('activity.form.incidental_food', 'Food while travelling'), hint: t('activity.form.incidental_food_hint', 'Meals while travelling') },
                ]).map((row) => (
                  <div key={row.key} className="flex flex-col gap-1">
                    <Label className="inline-flex items-center gap-1.5">
                      <row.icon className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
                      {row.label}
                    </Label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form[row.key]}
                      onChange={(e) => set(row.key, e.target.value)}
                      disabled={isReadOnly}
                      className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                    />
                    <span className="text-[10px] text-gray-500 dark:text-gray-400">{row.hint}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2 dark:border-gray-800">
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                  {t('activity.form.incidental_total', 'Total')}: <span className="tabular-nums">{fmtIncidental(incidentalTotal)}</span>
                </span>
                <Button type="button" size="sm" onClick={() => setIncidentalOpen(false)}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  {t('common.done', 'Done')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Meeting owner */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meeting-owner" className="inline-flex items-center gap-1.5">
            <UserRound className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.meeting_owner_label')}
          </Label>
          <input
            id="meeting-owner"
            type="text"
            value={meetingOwnerText}
            onChange={(e) => {
              const text = e.target.value
              setMeetingOwnerText(text)
              // v1.319.0: single-entry parse of the same "Name <email>"
              // convention Attendees uses, so meetingOwner (name) and
              // meetingOwnerEmail persist separately while the input shows
              // one combined line.
              const [entry] = parseAttendees(text)
              set('meetingOwner', entry?.name ?? '')
              set('meetingOwnerEmail', entry?.email ?? null)
            }}
            placeholder={t('activity.form.meeting_owner_placeholder')}
            disabled={isReadOnly}
            className="rounded border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 disabled:opacity-60"
          />
          <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('activity.form.meeting_owner_hint')}</p>
          {!isReadOnly && (
            <SfContactOwnerPicker
              onPick={(contact) => {
                set('meetingOwner', contact.name)
                set('meetingOwnerEmail', contact.email ?? null)
                setMeetingOwnerText(serializeAttendees([{ name: contact.name, email: contact.email ?? undefined }]))
                if (contact.email && !form.attendees.some((a) => a.email?.toLowerCase() === contact.email!.toLowerCase())) {
                  const next = [...form.attendees, { name: contact.name, email: contact.email }]
                  set('attendees', next)
                  setAttendeesText(serializeAttendees(next))
                }
              }}
            />
          )}
        </div>

        {/* Assigned Oppty SE — only when the activity is linked to an
            Opportunity. Writes back to the team's configured Assigned SE
            write-target field (Admin -> SF Field Mappings), falling back to
            Assigned_SE__c when unmapped — see resolveAssignedSeWriteField()
            in routes/salesforce.ts. Not Event/Task. */}
        {sfSelection?.type === 'Opportunity' && crmProvider !== 'none' && assignedSeMeta.configured && (
          <AssignedSePicker
            opportunityId={sfSelection.id}
            teamId={teamId}
            apiBase={crmApiBase}
            value={assignedSe}
            onChange={setAssignedSe}
            initialValue={initialAssignedSe}
            disabled={isReadOnly || !assignedSeMeta.canWrite}
            lockedHint={!isReadOnly && !assignedSeMeta.canWrite ? (assignedSeMeta.readOnlyReason === 'errors.hubspot.deal_not_named' ? t('activity.form.assigned_se_not_named_on_deal') : t('activity.form.assigned_se_no_hubspot_owner')) : null}
          />
        )}

        {/* v1.239.0: read-only meeting-response summary — sourced from the
            live Outlook event (or a matching suggested meeting), never
            saved with the activity. Only shown when at least one attendee
            actually carries a response (manually-typed attendees, or an
            activity with no matching calendar event, have none). */}
        {attendeeResponses.some((a) => a.response) && (
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
              <Users className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              {t('activity.form.attendee_responses_label')}
            </span>
            <div className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-gray-200 bg-gray-50 p-2 text-xs dark:border-gray-700 dark:bg-gray-800/60">
              {attendeeResponses.map((a, i) => (
                <div key={`${a.email ?? a.name ?? i}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="truncate text-gray-800 dark:text-gray-100">{a.name || a.email}</span>
                  {/* v1.241.0: Required/Optional alongside the RSVP. Graph
                      carries both on every attendee and this summary already
                      had `type` in hand — it just wasn't rendering it, so
                      "who actually needs to be here" was invisible next to
                      "who said yes". */}
                  <span className="flex shrink-0 items-center gap-1.5">
                    {a.response && <AttendeeResponseBadge response={a.response} className="text-[10px]" />}
                    {a.type && (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        {a.type === 'optional' ? <UserPlus className="h-3 w-3" /> : <UserLock className="h-3 w-3" />}
                        {a.type === 'optional'
                          ? t('activity.attendee_filter.optional_short')
                          : t('activity.attendee_filter.required_short')}
                      </Badge>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('activity.form.attendee_responses_hint')}</p>
          </div>
        )}

        {/* Attendees — one per line, "Name <email>" or plain email */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="attendees" className="inline-flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.attendees_label')}
          </Label>
          {/* v1.336.0: a click-to-remove chip row above the free-text
              textarea — requested so a contributor can drop someone who
              didn't actually attend without hand-editing the raw text. Reads
              form.attendees (already kept in sync with attendeesText on
              every keystroke), removes one entry, and re-serializes back
              into the same textarea state the typed-name flow already
              writes to — no new parsing path, no schema change. */}
          {!isReadOnly && form.attendees.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {form.attendees.map((a, i) => {
                const label = a.name && a.email ? `${a.name} <${a.email}>` : (a.name ?? a.email ?? '')
                return (
                  <span
                    key={`${a.email ?? a.name ?? ''}-${i}`}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-gray-50 py-0.5 pl-1 pr-2 text-[11px] text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const next = form.attendees.filter((_, idx) => idx !== i)
                        set('attendees', next)
                        setAttendeesText(serializeAttendees(next))
                      }}
                      title={t('activity.form.attendees_remove', 'Remove {{who}}', { who: label })}
                      aria-label={t('activity.form.attendees_remove', 'Remove {{who}}', { who: label })}
                      className="shrink-0 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    >
                      <CircleMinus className="h-3.5 w-3.5" />
                    </button>
                    <span className="truncate">{label}</span>
                  </span>
                )
              })}
            </div>
          )}
          <Textarea
            id="attendees"
            value={attendeesText}
            onChange={(e) => {
              setAttendeesText(e.target.value)
              set('attendees', parseAttendees(e.target.value))
            }}
            placeholder={t('activity.form.attendees_placeholder')}
            disabled={isReadOnly}
            rows={3}
          />
          <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('activity.form.attendees_hint')}</p>
          {/* v1.246.0: was two separate always-visible search rows (global
              Salesforce contacts/users, and — only once an Opportunity or
              Account is linked — contacts on that record). Merged into one
              row with a two-icon toggle (highlighted blue = active choice)
              so the drawer doesn't grow by a whole extra line the moment an
              SF Link is picked. Same drawer/component for both the Approve
              flow and editing an existing activity, so this is identical in
              both. Neither underlying search (global vs. account-scoped) nor
              its API calls changed — only which one is visible and how it's
              triggered. */}
          {!isReadOnly && (sfConnected || crmProvider === 'hubspot') && (
            <AttendeeSfSearchBar
              hasAccountOption={crmProvider !== 'none' && (sfSelection?.type === 'Opportunity' || sfSelection?.type === 'Account')}
              onPickGlobal={(contact) => {
                if (contact.email && form.attendees.some((a) => a.email?.toLowerCase() === contact.email!.toLowerCase())) return
                const next = [...form.attendees, { name: contact.name, email: contact.email ?? undefined }]
                set('attendees', next)
                setAttendeesText(serializeAttendees(next))
              }}
              accountProps={
                crmProvider !== 'none' && sfSelection && (sfSelection.type === 'Opportunity' || sfSelection.type === 'Account')
                  ? {
                      linkedId: sfSelection.id,
                      linkedType: sfSelection.type,
                      existing: form.attendees,
                      onAdd: (contact) => {
                        const already = form.attendees.some((a) => a.email && contact.email && a.email.toLowerCase() === contact.email.toLowerCase())
                        if (already) return
                        const next = [...form.attendees, { name: contact.name, email: contact.email ?? undefined }]
                        set('attendees', next)
                        setAttendeesText(serializeAttendees(next))
                      },
                    }
                  : null
              }
            />
          )}
        </div>

        {/* Event description body (from the calendar event) */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="description-body" className="inline-flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
            {t('activity.form.description_body_label')}
          </Label>
          <Textarea
            id="description-body"
            value={form.descriptionBody}
            onChange={(e) => set('descriptionBody', e.target.value)}
            placeholder={t('activity.form.description_body_placeholder')}
            disabled={isReadOnly}
            rows={4}
          />
          <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('activity.form.description_body_hint')}</p>
        </div>

        {/* Notes — app-only, not tied to the calendar event description.
            Shown only on activity creation. Once the activity exists, all
            note review/creation — including the Engineer Notes checkbox
            below, for Eval Work — happens in the dedicated Notes tab
            (v1.254.2) above, so the free-text field here would just be a
            duplicate write path. */}
        {!editActivity && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes" className="inline-flex items-center gap-1.5">
              <StickyNote className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              {t('activity.form.notes_label')}
              <MarkdownHelpPopover />
            </Label>
            <Textarea
              id="notes"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder={t('activity.form.notes_placeholder')}
              disabled={isReadOnly}
            />
            <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('activity.form.notes_hint')}</p>
            {/* v1.254.0: post this Notes text to the linked Project's
                Engineer Notes field as a dated, prepended entry (history
                preserved) — only offered once a Project is actually linked. */}
            {crmProjects && form.crmRelatedType && form.crmRelatedId && (
              <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={postToEngineerNotes}
                  onChange={(e) => { setPostToEngineerNotes(e.target.checked); setEngineerNotesError(null) }}
                  disabled={isReadOnly}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 dark:border-gray-600"
                />
                {t('activity.form.post_to_engineer_notes', 'Also post this to Engineer Notes on the linked Project')}
              </label>
            )}
            {engineerNotesError && (
              <p className="text-[10px] text-red-600 dark:text-red-400">{engineerNotesError.startsWith('errors.') ? t(engineerNotesError) : engineerNotesError}</p>
            )}
            {/* v1.307.0: same "Push to Salesforce" ContentNote mechanism as
                My Notes' own Push button and NotesPanel's identical edit-mode
                checkboxes — see oppNotesPushTarget/acctNotesPushTarget above.
                v1.308.1: same row, each with a hover tooltip — see the
                identical layout comment in NotesDrawer.tsx. */}
            {(oppNotesPushTarget || acctNotesPushTarget) && (
              <div className="flex items-center gap-3">
                {oppNotesPushTarget && (
                  <label
                    className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400"
                    title={t('activity.notes.post_to_opp_notes_tip', { context: crmCtx })}
                  >
                    <input
                      type="checkbox"
                      checked={postToOppNotes}
                      onChange={(e) => { setPostToOppNotes(e.target.checked); setSfNotesPushError(null) }}
                      disabled={isReadOnly}
                      className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 dark:border-gray-600"
                    />
                    {t('activity.notes.post_to_opp_notes', { context: crmCtx })}
                  </label>
                )}
                {acctNotesPushTarget && (
                  <label
                    className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400"
                    title={t('activity.notes.post_to_acct_notes_tip', { context: crmCtx })}
                  >
                    <input
                      type="checkbox"
                      checked={postToAcctNotes}
                      onChange={(e) => { setPostToAcctNotes(e.target.checked); setSfNotesPushError(null) }}
                      disabled={isReadOnly}
                      className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 dark:border-gray-600"
                    />
                    {t('activity.notes.post_to_acct_notes', { context: crmCtx })}
                  </label>
                )}
              </div>
            )}
            {sfNotesPushError && (
              <p className="text-[10px] text-red-600 dark:text-red-400">{sfNotesPushError}</p>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {/* v1.161.0: heads-up that submitting will write to Outlook, and that
            internal attendees get an invite while external ones only land in
            the event description. Shown for the write-back-eligible case: opted
            in, a new activity, not sourced from an existing meeting. */}
        {!isReadOnly && !editActivity && !form.outlookEventId && currentUser?.outlookWritebackEnabled && (
          <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            {internalDomains.length > 0
              ? t('activity.form.outlook_writeback_note_domains', 'Submitting creates an event on your Outlook calendar. Attendees at {{domains}} get an Outlook invite; all other (external) attendees are added to the event description only.', { domains: internalDomains.map((d) => `@${d}`).join(', ') })
              : t('activity.form.outlook_writeback_note', 'Submitting creates an event on your Outlook calendar. Internal attendees (your organization) receive an Outlook invite; external attendees are added to the event description only.')}
          </p>
        )}

        {!isReadOnly && (
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleSave('draft')}
              disabled={saving || isNonActivity || endBeforeStart || productsMissing || subtypeMissing}
              title={isNonActivity ? t('activity.non_activity.approve_disabled') : validationBlockedTitle}
            >
              {saving ? <Spinner className="mr-1 h-4 w-4" /> : <Save className="mr-1 h-4 w-4" />}
              {t('activity.form.save_draft')}
            </Button>
            <Button
              type="submit"
              disabled={saving || isNonActivity || endBeforeStart || productsMissing || subtypeMissing}
              title={isNonActivity ? t('activity.non_activity.approve_disabled') : validationBlockedTitle}
            >
              {saving ? <Spinner className="mr-1 h-4 w-4" /> : <Send className="mr-1 h-4 w-4" />}
              {editActivity
                ? t('activity.form.submit_button_update', 'Submit and Update Activity')
                : t('activity.form.submit_button_create', 'Submit and Approve Activity')}
            </Button>
          </div>
        )}
      </form>
      )}
      {deletePromptOpen && editActivity && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={() => !deleting && setDeletePromptOpen(false)}>
          <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 flex items-center gap-2 text-base font-semibold text-red-700 dark:text-red-300">
              <Trash2 className="h-4 w-4" />
              {t('activity.form.delete_title', 'Delete this activity?')}
            </h3>
            <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
              {editActivity.crmRecordId
                ? t('activity.form.delete_body_synced', { context: crmCtx })
                : t('activity.form.delete_body_local', 'This will remove the activity from ImpactIQ. This cannot be undone.')}
            </p>
            <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">
              {t('activity.form.delete_prompt', 'Type ')}<code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">delete</code>{t('activity.form.delete_prompt_suffix', ' to confirm.')}
            </p>
            <Input
              autoFocus
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="delete"
              disabled={deleting}
            />
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={deleteNotes}
                onChange={(e) => setDeleteNotes(e.target.checked)}
                disabled={deleting}
                className="h-4 w-4"
              />
              {t('activity.form.delete_notes_label', 'Delete notes related to activity')}
            </label>
            {wroteToOutlook && (
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deleteOutlookEvent}
                  onChange={(e) => setDeleteOutlookEvent(e.target.checked)}
                  disabled={deleting}
                  className="h-4 w-4"
                />
                {t('activity.form.delete_outlook_label', 'Also delete the event from my Outlook calendar')}
              </label>
            )}
            {wroteToOutlook && deleteOutlookEvent && (
              <p className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('activity.form.delete_outlook_delay', 'Removing it from both ImpactIQ and Outlook can take up to ~2 minutes to fully propagate.')}
              </p>
            )}
            {deleteError && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">{deleteError}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setDeletePromptOpen(false); setDeleteConfirmText(''); setDeleteNotes(false); setDeleteError(null) }} disabled={deleting}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void confirmDelete()}
                disabled={deleting || deleteConfirmText.trim().toLowerCase() !== 'delete'}
                className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleting ? <Spinner className="mr-1 h-3 w-3" /> : <Trash2 className="mr-1 h-3 w-3" />}
                {t('activity.form.delete_confirm', 'Delete permanently')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}
