import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { format, differenceInMinutes } from 'date-fns'
import { Sparkles, Check, Pencil, Bookmark, ChevronDown, ChevronRight, CalendarOff, UserPlus, UserLock, Lock, MessageCircleText } from 'lucide-react'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { cn } from '../../lib/utils.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { PossibleMatchChip } from './PossibleMatchChip.js'
import { ProjectMatchChip } from './ProjectMatchChip.js'
import { api } from '../../lib/api.js'
import type { Suggestion } from '../../hooks/useSuggestions.js'
import type { Activity } from '../../hooks/useActivities.js'
import { useTeamProducts } from '../../hooks/useProducts.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { formatTimeInTZ } from '../../lib/tz.js'

interface Props {
  suggestion: Suggestion
  teamId: string
  onApproved: () => void
  onEdit: (prefill: { outlookEventId: string; title: string; startDatetime: string; endDatetime: string; activityTypeId: string | null; descriptionBody?: string; meetingOwner?: string; meetingOwnerEmail?: string | null; attendees?: { name?: string; email?: string; response?: string; type?: string }[]; isPrivate?: boolean }) => void
  onMarkNonActivity?: (outlookEventId: string) => void
  onUnmarkNonActivity?: (outlookEventId: string) => void
  isNonActivity?: boolean
  // v1.262.0: team's configured Non-Activity anchor color (from
  // useSuggestions()'s meta.nonActivityColor), reused as the Private
  // Meeting card background when set. Falls back to plain light gray
  // client-side when null. See CLAUDE.md §7 Private Meetings.
  nonActivityColor?: string | null
  // v1.240.0: the current user's own Graph attendee.type on this meeting —
  // null when they're the organizer (Graph omits the organizer from
  // `attendees` entirely) or Outlook otherwise didn't include them.
  myAttendeeType?: 'required' | 'optional' | null
  // v1.456.0: Gong has a recording of this meeting.
  gongRecorded?: boolean
}

export function SuggestedActivityCard({ suggestion, teamId, onApproved, onEdit, onMarkNonActivity, onUnmarkNonActivity, isNonActivity, nonActivityColor, myAttendeeType, gongRecorded = false }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [showMatchDetails, setShowMatchDetails] = useState(false)
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; titleTemplate: string; notesTemplate: string | null; activityTypeId: string | null; subtypeId: string | null; effortHoursDefault: string | null; locationModeDefault: string | null; productIds: string[] | null }>>([])
  const [tplOpen, setTplOpen] = useState(false)
  const [tplRect, setTplRect] = useState<{ top: number; right: number } | null>(null)
  const [attendeesOpen, setAttendeesOpen] = useState(false)
  // v1.91.0: local override + recompute state so the chips update in-place
  // without waiting for the parent's next poll of /api/outlook/suggestions.
  const [localOverride, setLocalOverride] = useState<{ id: string; type: 'Account' | 'Opportunity'; name: string } | null>(suggestion.userOverrideSfWhat)
  const [localAccount, setLocalAccount] = useState<{ id: string; name: string } | null>(suggestion.suggestedAccount)
  const [localOpportunity, setLocalOpportunity] = useState<{ id: string; name: string } | null>(suggestion.suggestedOpportunity)
  const [localCandidates, setLocalCandidates] = useState<Array<{ id: string; name: string; type: 'Account' | 'Opportunity' }> | null>(suggestion.suggestionCandidates)
  // v1.100.0: Project selection (sfRelated on the resulting activity)
  // sourced from the activity type's SF Extras related_object_picker.
  const [localProject, setLocalProject] = useState<{ id: string; name: string; sobject: string } | null>(null)

  async function onOverride(pick: { id: string; type: 'Account' | 'Opportunity'; name: string } | null) {
    setLocalOverride(pick)
    await api.patch(`/api/outlook/suggestions/${encodeURIComponent(suggestion.outlookEventId)}/override`, pick ?? { id: null, type: null, name: null })
  }
  const tplRef = useRef<HTMLDivElement | null>(null)
  const tplBtnRef = useRef<HTMLButtonElement | null>(null)
  const tplPopRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!tplOpen || !tplBtnRef.current) return
    const b = tplBtnRef.current.getBoundingClientRect()
    setTplRect({ top: b.bottom + 4, right: window.innerWidth - b.right })
  }, [tplOpen])
  useEffect(() => {
    let cancelled = false
    async function load() {
      const r = await api.get<typeof templates>('/api/templates')
      if (!cancelled) setTemplates(r.data ?? [])
    }
    void load()
    // v1.92.0: refresh the template list when a new one is created from the
    // Activities-page New Template modal, so Approve-with-Template shows
    // up immediately without a page reload.
    function onChanged() { void load() }
    window.addEventListener('impactiq:templates-changed', onChanged)
    return () => { cancelled = true; window.removeEventListener('impactiq:templates-changed', onChanged) }
  }, [])
  useEffect(() => {
    if (!tplOpen) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (tplRef.current?.contains(t)) return
      if (tplPopRef.current?.contains(t)) return
      setTplOpen(false)
    }
    const onScroll = (e: Event) => {
      if (tplPopRef.current?.contains(e.target as Node)) return
      setTplOpen(false)
    }
    const onResize = () => setTplOpen(false)
    document.addEventListener('mousedown', h)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', h)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [tplOpen])
  const teamProducts = useTeamProducts(teamId)
  const activeProducts = teamProducts.filter((p) => p.isActive)
  // "None" is the default selection. selectedIds is empty until the user
  // ticks at least one product chip; ticking a product auto-clears "None".
  const [noneSelected, setNoneSelected] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // v1.180.0: Approve pre-check state. `productChosen` becomes true once the
  // user explicitly picks a product OR clicks None, so the default (untouched)
  // "None" doesn't silently satisfy the "chose a product" check. `evalApplicable`
  // is lifted from ProjectMatchChip. `blockers` renders the inline error list.
  const [productChosen, setProductChosen] = useState(false)
  const [evalApplicable, setEvalApplicable] = useState(false)
  const [blockers, setBlockers] = useState<string[]>([])
  function toggleProduct(id: string) {
    setProductChosen(true)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setNoneSelected(next.size === 0)
      return next
    })
  }
  function selectNone() {
    setProductChosen(true)
    setSelectedIds(new Set())
    setNoneSelected(true)
  }

  const color = isNonActivity ? null : (suggestion.suggestedActivityTypeColor ?? null)
  // v1.262.0: independent of isNonActivity — a private meeting always gets
  // the Private Meeting treatment (masked title, lock icon, tinted
  // background), even one that's ALSO been auto-marked Non-Activity. Only
  // the background/border defer to the Non-Activity gray-out, since that
  // treatment already communicates "excluded" on its own.
  const isPrivate = suggestion.isPrivate
  const tintStyle = isNonActivity
    ? undefined
    : isPrivate && nonActivityColor
    ? { backgroundColor: `${nonActivityColor}26`, borderLeft: `3px dashed ${nonActivityColor}` }
    : color
    ? { backgroundColor: `${color}0F`, borderLeft: `3px dashed ${color}` }
    : undefined
  const { user: tzUser } = useCurrentUser()
  const startTime = formatTimeInTZ(suggestion.start, tzUser?.timezone ?? null)
  const durH = (differenceInMinutes(new Date(suggestion.end), new Date(suggestion.start)) / 60).toFixed(1)
  // v1.241.0: the viewer's own RSVP is Tentative. Read straight off the
  // suggestion (the live Graph value) rather than persisted anywhere, so it
  // tracks an RSVP change on the next poll instead of freezing at whatever it
  // was when the card first rendered.
  const isTentative = suggestion.responseStatus === 'tentativelyAccepted'

  async function approve(templateId?: string) {
    const tpl = templateId ? templates.find((tt) => tt.id === templateId) : null
    // Template overrides beat the auto-suggestion but never the raw meeting time.
    const activityTypeId = tpl?.activityTypeId ?? suggestion.suggestedActivityTypeId
    if (!activityTypeId) { edit(); return }
    const effort = tpl?.effortHoursDefault ? Number(tpl.effortHoursDefault) : Math.max(0.25, Number(durH))
    const tplHasProducts = !!(tpl && Array.isArray(tpl.productIds) && tpl.productIds.length > 0)
    const productIds = tplHasProducts
      ? tpl!.productIds!
      : (noneSelected ? [] : Array.from(selectedIds))
    // v1.91.0: Choose the SF link — user override first, else Opportunity
    // suggestion (higher fidelity), else Account. Nulls fall through.
    const sfWhat = localOverride
      ?? (localOpportunity ? { id: localOpportunity.id, type: 'Opportunity' as const, name: localOpportunity.name } : null)
      ?? (localAccount ? { id: localAccount.id, type: 'Account' as const, name: localAccount.name } : null)

    // v1.180.0: pre-approval checks. Hard blocks stop the approve and open the
    // Edit drawer so the user can fix them; confirm-only items are acknowledged
    // in a single prompt. A template that carries products satisfies the
    // product check.
    const hardBlocks: string[] = []
    if (!productChosen && !tplHasProducts) hardBlocks.push(t('activity.approve_check.no_product', 'Choose a product (or None) before approving.'))
    if (!sfWhat) hardBlocks.push(t('activity.approve_check.no_sf_link', 'Link an Account or Opportunity before approving.'))
    if (sfWhat?.type === 'Opportunity' && evalApplicable && !localProject) {
      hardBlocks.push(t('activity.approve_check.no_evaluation'))
    }
    if (hardBlocks.length > 0) {
      setBlockers(hardBlocks)
      edit() // inline error + open the drawer to fix
      return
    }
    setBlockers([])
    // Confirm-only reviews (the card doesn't capture Assigned SE / location /
    // incidentals — those live in the drawer, so we prompt to review them).
    const reviewLines = [
      suggestion.suggestedActivityTypeName
        ? t('activity.approve_check.confirm_type', 'Activity type: {{type}}', { type: suggestion.suggestedActivityTypeName })
        : '',
      t('activity.approve_check.confirm_reviews', 'Please confirm you reviewed the Assigned SE, and (for on-site meetings) any travel/incidental costs. Open Edit to change them.'),
    ].filter(Boolean)
    const proceed = window.confirm(`${t('activity.approve_check.confirm_title', 'Approve this activity?')}\n\n${reviewLines.join('\n')}`)
    if (!proceed) { edit(); return }
    setBusy(true)
    // v1.117.0: derive the Account snapshot that gets written onto the
    // activity so ActivityCard renders the clickable Account link.
    // When the pick is an Opportunity, prefer its parent Account from
    // the cached suggestion payload; when it's an Account, use it
    // directly. Nulls fall through untouched.
    const sfAccount: { id: string | null; name: string } | null =
      sfWhat?.type === 'Opportunity'
        ? {
            id: (suggestion.suggestedOpportunity?.accountId ?? null) as string | null,
            name: (suggestion.suggestedOpportunity?.accountName ?? '') as string,
          }
        : sfWhat?.type === 'Account'
          ? { id: sfWhat.id, name: sfWhat.name }
          : null
    const payload: Record<string, unknown> = {
      teamId,
      title: tpl?.titleTemplate || suggestion.subject,
      activityTypeId,
      startDatetime: suggestion.start,
      endDatetime: suggestion.end,
      effortHours: effort,
      outlookEventId: suggestion.outlookEventId,
      status: 'submitted' as const,
      isPrivateMeeting: suggestion.isPrivate,
      productIds,
      descriptionBody: suggestion.bodyPreview ?? undefined,
      meetingOwner: suggestion.meetingOwner ?? undefined,
      // v1.319.0: same organizer email already resolved for the
      // required/optional check below — reused here so the persisted row
      // carries it from the very first quick-approve, not just after an
      // edit-then-save round trip.
      meetingOwnerEmail: suggestion.meetingOwner ? (suggestion.organizerEmail ?? undefined) : undefined,
      // v1.239.0: suggestion.attendees now also carries response/type (for
      // the Log Activity form's read-only summary on the Edit path) — strip
      // back to name/email here since this quick-approve path POSTs directly
      // to /api/activities without going through the form, and the
      // persisted attendees column has always been name/email only.
      attendees: (suggestion.attendees ?? []).length > 0
        ? suggestion.attendees?.map((a) => ({ name: a.name, email: a.email }))
        : undefined,
      ...(sfWhat && { crmWhatId: sfWhat.id, crmWhatType: sfWhat.type, crmWhatName: sfWhat.name }),
      ...(sfAccount && (sfAccount.id || sfAccount.name) && { crmAccountId: sfAccount.id, crmAccountName: sfAccount.name || null }),
      // v1.100.0: propagate the Project pick to the activity so cards
      // render "Project: X" without needing a follow-up edit.
      ...(localProject && sfWhat?.type === 'Opportunity' && {
        crmRelatedType: localProject.sobject,
        crmRelatedId: localProject.id,
        crmRelatedName: localProject.name,
      }),
    }
    if (tpl?.notesTemplate) payload['notes'] = tpl.notesTemplate
    if (tpl?.locationModeDefault) payload['locationMode'] = tpl.locationModeDefault
    // v1.256.0: a template's Subtype is only ever set alongside its own
    // activityTypeId (the picker is scoped to that type), so it's safe to
    // carry through unconditionally here — no separate mismatch case to
    // guard against.
    if (tpl?.subtypeId) payload['subtypeId'] = tpl.subtypeId
    const res = await api.post<Activity>('/api/activities', payload)
    if (res.data) await api.patch(`/api/activities/${res.data.id}`, { status: 'submitted' })
    setBusy(false)
    onApproved()
  }
  function edit() {
    // v1.90.0: also carry meetingOwner / attendees / descriptionBody so the
    // opened form shows the Outlook context the card already displays.
    // Without these the form starts blank and the fields get written back
    // empty on save — which is what caused the "Edit shows blank Meeting
    // owner / Attendees / Event description" bug on activities that came
    // from the Suggested card's Edit button.
    onEdit({
      outlookEventId: suggestion.outlookEventId,
      title: suggestion.subject,
      startDatetime: suggestion.start,
      endDatetime: suggestion.end,
      activityTypeId: suggestion.suggestedActivityTypeId,
      descriptionBody: suggestion.bodyPreview ?? undefined,
      meetingOwner: suggestion.meetingOwner ?? undefined,
      meetingOwnerEmail: suggestion.meetingOwner ? (suggestion.organizerEmail ?? undefined) : undefined,
      attendees: (suggestion.attendees ?? undefined),
      isPrivate: suggestion.isPrivate,
    })
  }

  return (
    <div
      className={cn(
        'relative flex flex-col gap-2 overflow-hidden rounded-md border border-dashed p-3 transition-colors',
        isNonActivity
          ? 'border-gray-600 bg-gray-600 text-gray-100 hover:bg-gray-700 dark:border-gray-500 dark:bg-gray-700 dark:hover:bg-gray-600'
          : isPrivate && !nonActivityColor
          ? 'border-gray-300 bg-gray-100 hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-800/60 dark:hover:bg-gray-800'
          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50',
        !isNonActivity && !isPrivate && !color && 'border-amber-300 bg-amber-50/40 dark:border-amber-700 dark:bg-amber-950/20',
        // v1.241.0: tentative RSVP. Only touches background-IMAGE, so the
        // per-type background-color (tintStyle) and the dashed
        // not-yet-approved border both survive underneath it.
        isTentative && 'stripe-tentative',
      )}
      style={tintStyle}
      title={isTentative ? t('activity.tentative.hint') : undefined}
    >
      {/* v1.262.0: large transparent watermark — purely decorative, never
          intercepts clicks or covers the action row (it's behind, low
          opacity, and the buttons sit in normal flow above it). */}
      {isPrivate && (
        <Lock className="pointer-events-none absolute -bottom-3 -right-3 h-28 w-28 text-gray-400 opacity-20 dark:text-gray-300" aria-hidden="true" />
      )}
      <div className="flex items-start justify-between gap-2">
        <span className={cn('flex flex-1 items-center gap-1.5 text-sm font-medium', isNonActivity ? 'text-gray-50' : 'text-gray-900 dark:text-gray-100')}>
          {isPrivate ? (
            <Lock className="h-4 w-4 shrink-0" />
          ) : !isNonActivity && suggestion.suggestedActivityTypeIcon ? (
            <DynamicIcon
              name={suggestion.suggestedActivityTypeIcon}
              className="h-4 w-4 shrink-0"
              {...(color ? { style: { color } } : {})}
            />
          ) : isNonActivity ? (
            <CalendarOff className="h-4 w-4 shrink-0 text-gray-300" />
          ) : null}
          <span className="line-clamp-2">
            {isPrivate ? t('activity.private_meeting.title', 'Private meeting') : suggestion.subject}
          </span>
        </span>
        {/* v1.240.0: the current user's own Required/Optional attendee status
            — previously only shown per-attendee (not specifically "you") in
            the Outlook event modal, and only after opening it. Placed left of
            Not Approved / Non-Activity so both badges read as one cluster. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {gongRecorded && (
            <Badge
              variant="outline"
              className={cn('gap-1', isNonActivity && 'border-gray-500 bg-gray-700 text-gray-100')}
              title={t('activity.gong.recorded_hint')}
            >
              <MessageCircleText className="h-3 w-3" />
              {t('activity.gong.recorded')}
            </Badge>
          )}
          {isPrivate && (
            <Badge
              variant="outline"
              className={cn('gap-1', isNonActivity && 'border-gray-500 bg-gray-700 text-gray-100')}
              title={t('activity.private_meeting.pill_hint', "This meeting is marked Private/Confidential in Outlook — it's shown here as Private meeting.")}
            >
              <Lock className="h-3 w-3" />
              {t('activity.private_meeting.pill', 'Private')}
            </Badge>
          )}
          {myAttendeeType && (
            <Badge
              variant="outline"
              className={cn('gap-1', isNonActivity && 'border-gray-500 bg-gray-700 text-gray-100')}
            >
              {myAttendeeType === 'optional' ? <UserPlus className="h-3 w-3" /> : <UserLock className="h-3 w-3" />}
              {myAttendeeType === 'optional'
                ? t('activity.attendee_filter.you_optional', 'You: Optional')
                : t('activity.attendee_filter.you_required', 'You: Required')}
            </Badge>
          )}
          <Badge variant={isNonActivity ? 'secondary' : 'warning'} className={cn('gap-1', isNonActivity && 'bg-gray-800 text-gray-100 border-gray-500')}>
            {isNonActivity ? <CalendarOff className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
            {isNonActivity ? t('activity.non_activity.badge', 'Non-Activity') : t('activity.suggested.not_approved')}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {isNonActivity ? (
          <Badge variant="secondary" className="bg-gray-800 text-gray-100 border-gray-500">
            {t('activity.non_activity.type_none', 'None')}
          </Badge>
        ) : suggestion.suggestedActivityTypeName ? (
          <Badge
            variant="secondary"
            style={color ? { backgroundColor: color, color: '#fff', borderColor: color } : undefined}
          >
            {suggestion.suggestedActivityTypeName}
          </Badge>
        ) : (
          // v1.241.0: nothing matched and no default is configured. Distinct
          // from the "None" badge above on purpose — that one means "an admin
          // (or a rule) decided this isn't work", whereas this means "nobody
          // has decided yet". Rendering them identically is what made
          // unmatched meetings look excluded in v1.240.0.
          <Badge
            variant="outline"
            className="border-gray-300 bg-white text-gray-600 dark:border-gray-600 dark:bg-gray-100 dark:text-gray-700"
            title={t('activity.suggested.unmatched_hint')}
          >
            {t('activity.suggested.unmatched')}
          </Badge>
        )}
        {suggestion.suggestionSource === 'keyword' ? (
          <button
            type="button"
            onClick={() => setShowMatchDetails((v) => !v)}
            className={cn(
              'rounded text-[10px] uppercase tracking-wide underline decoration-dotted underline-offset-2',
              isNonActivity
                ? 'text-gray-300 hover:text-white'
                : 'text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300',
            )}
            title={t('activity.suggested.match_details_hint')}
          >
            {t('activity.suggested.by_keyword')}
          </button>
        ) : suggestion.suggestionSource === 'user_keyword' ? (
          // v1.243.0: the user's OWN keyword did this, not a team rule. Labelled
          // and linked differently on purpose — sending someone to Admin →
          // Keyword Rules to find a rule that isn't there (and that they may
          // not have access to) is worse than not explaining it at all.
          <button
            type="button"
            onClick={() => setShowMatchDetails((v) => !v)}
            className={cn(
              'rounded text-[10px] uppercase tracking-wide underline decoration-dotted underline-offset-2',
              isNonActivity
                ? 'text-gray-300 hover:text-white'
                : 'text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300',
            )}
            title={t('activity.suggested.by_user_keyword_hint')}
          >
            {t('activity.suggested.by_user_keyword')}
          </button>
        ) : suggestion.suggestionSource === 'none' && !suggestion.suggestedActivityTypeId ? (
          // No keyword/AI match AND no configured default — labelling this
          // "DEFAULT" (below) would claim a default that doesn't exist. The
          // No Match badge above already carries the meaning.
          null
        ) : (
          <span
            className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400"
            title={suggestion.suggestionSource === 'none' ? t('activity.suggested.default_hint') : t('activity.suggested.ai_hint')}
          >
            {suggestion.suggestionSource === 'ai' && t('activity.suggested.by_ai')}
            {suggestion.suggestionSource === 'none' && t('activity.suggested.by_default')}
          </span>
        )}
        {/* v1.91.0: SF possible-match chips (cached on outlook_events;
            zero SF calls on poll). v1.100.0: labelled "Suggestions:" so
            the intent is clear even when a chip is still in Pick-state. */}
        <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('activity.suggested.chips_label', 'Suggestions:')}
        </span>
        <PossibleMatchChip
          kind="Account"
          eventId={suggestion.outlookEventId}
          current={localOverride?.type === 'Account' ? { id: localOverride.id, name: localOverride.name } : (localAccount ?? suggestion.suggestedAccount ?? null)}
          candidates={localCandidates ?? suggestion.suggestionCandidates ?? null}
          onPick={(pick) => onOverride(pick)}
          onClear={() => {
            // v1.100.0: clear ONLY the Account slot — leave Opportunity
            // untouched. If the override was Account, drop it too.
            setLocalAccount(null)
            if (localOverride?.type === 'Account') void onOverride(null)
          }}
          onRecomputed={(payload) => { setLocalAccount(payload.suggestedAccount); setLocalOpportunity(payload.suggestedOpportunity); setLocalCandidates(payload.suggestionCandidates) }}
          onSearchMore={() => edit()}
        />
        <PossibleMatchChip
          kind="Opportunity"
          eventId={suggestion.outlookEventId}
          current={localOverride?.type === 'Opportunity' ? { id: localOverride.id, name: localOverride.name } : (localOpportunity ?? suggestion.suggestedOpportunity ?? null)}
          candidates={localCandidates ?? suggestion.suggestionCandidates ?? null}
          onPick={(pick) => onOverride(pick)}
          onClear={() => {
            setLocalOpportunity(null)
            if (localOverride?.type === 'Opportunity') void onOverride(null)
          }}
          onRecomputed={(payload) => { setLocalAccount(payload.suggestedAccount); setLocalOpportunity(payload.suggestedOpportunity); setLocalCandidates(payload.suggestionCandidates) }}
          onSearchMore={() => edit()}
        />
        {/* v1.100.0: Project chip driven by per-activity-type SF Extras
            (e.g. Eval Work → Evaluation__c). Only renders when the
            suggested Opportunity is set AND the activity type has a
            related_object_picker extra configured. */}
        {(() => {
          const oppForProject = localOverride?.type === 'Opportunity'
            ? { id: localOverride.id, name: localOverride.name }
            : (localOpportunity ?? suggestion.suggestedOpportunity ?? null)
          if (!oppForProject || !suggestion.suggestedActivityTypeId) return null
          return (
            <ProjectMatchChip
              activityTypeId={suggestion.suggestedActivityTypeId}
              oppId={oppForProject.id}
              oppName={oppForProject.name}
              current={localProject}
              onPick={setLocalProject}
              onClear={() => setLocalProject(null)}
              onApplicableChange={setEvalApplicable}
            />
          )
        })()}
      </div>
      {showMatchDetails && (suggestion.suggestionSource === 'keyword' || suggestion.suggestionSource === 'user_keyword') && (
        <div className="rounded-md border border-blue-200 bg-blue-50/60 p-2 text-[11px] text-gray-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-gray-200">
          <div className="mb-1 font-semibold">{t('activity.suggested.match_details_title')}</div>
          {suggestion.matchedKeywords && suggestion.matchedKeywords.length > 0 && (
            <div className="mb-1">
              <span className="text-gray-500 dark:text-gray-400">{t('activity.suggested.matched_keywords')}: </span>
              {suggestion.matchedKeywords.map((kw, i) => (
                <code key={i} className="mr-1 rounded bg-white px-1 py-px text-[10px] text-blue-700 dark:bg-gray-900 dark:text-blue-300">{kw}</code>
              ))}
            </div>
          )}
          {suggestion.matchedRuleField && (
            <div><span className="text-gray-500 dark:text-gray-400">{t('activity.suggested.matched_field')}: </span>{suggestion.matchedRuleField}</div>
          )}
          {/* Team rule → the admin page. The user's own keyword → their own
              settings. A user_keyword match has no matchedRuleId (there's no
              rule row behind it), so these two can't collide. */}
          {suggestion.suggestionSource === 'user_keyword' ? (
            <div className="mt-1">
              <a href="/settings" className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400">
                {t('activity.suggested.view_my_keywords')}
              </a>
            </div>
          ) : suggestion.matchedRuleId && (
            <div className="mt-1">
              <a href={`/admin/keyword-rules?ruleId=${suggestion.matchedRuleId}`} className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400">
                {t('activity.suggested.view_rule')}
              </a>
            </div>
          )}
        </div>
      )}
      {activeProducts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('activity.suggested.products_label')}:
          </span>
          <button
            type="button"
            onClick={selectNone}
            disabled={isNonActivity}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] transition-colors',
              isNonActivity
                ? 'cursor-not-allowed border-gray-500 bg-gray-800 text-gray-400 opacity-60'
                : noneSelected
                ? 'border-gray-700 bg-gray-700 text-white dark:border-gray-300 dark:bg-gray-300 dark:text-gray-900'
                : 'border-gray-300 bg-white text-gray-600 hover:border-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300',
            )}
            title={isNonActivity ? t('activity.non_activity.approve_disabled') : t('activity.suggested.products_none_hint')}
          >
            {t('activity.suggested.products_none')}
          </button>
          {activeProducts.map((p) => {
            const checked = selectedIds.has(p.id)
            const label = p.abbreviation || p.name
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggleProduct(p.id)}
                disabled={isNonActivity}
                title={isNonActivity ? t('activity.non_activity.approve_disabled') : p.name}
                aria-pressed={checked}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                  isNonActivity
                    ? 'cursor-not-allowed border-gray-500 bg-gray-800 text-gray-400 opacity-60'
                    : checked
                    ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                    : 'border-gray-300 bg-white text-gray-600 hover:border-blue-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300',
                )}
              >
                {p.iconDataUrl && <img src={p.iconDataUrl} alt="" className="h-3 w-3 shrink-0 rounded-sm object-contain" />}
                {label}
              </button>
            )
          })}
        </div>
      )}
      {suggestion.meetingOwner && (
        <div className={cn('text-xs', isNonActivity ? 'text-gray-200' : 'text-gray-600 dark:text-gray-300')}>
          <span className={cn(isNonActivity ? 'text-gray-300' : 'text-gray-500 dark:text-gray-400')}>{t('activity.meeting_owner')}:</span>{' '}
          {/* v1.319.0: hover reveals the organizer's email — two people can share a display name across different orgs. */}
          <span title={suggestion.organizerEmail ?? undefined}>{suggestion.meetingOwner}</span>
        </div>
      )}
      {suggestion.attendees && suggestion.attendees.length > 0 && (
        <div className="text-xs">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setAttendeesOpen((v) => !v) }}
            className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
          >
            {attendeesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {t('activity.attendees_label', { count: suggestion.attendees.length })}
          </button>
          {attendeesOpen && (
            <div className="mt-1 whitespace-pre-wrap break-words rounded-md bg-gray-50 px-2 py-1 text-[11px] text-gray-700 dark:bg-gray-800/60 dark:text-gray-200">
              {suggestion.attendees.map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : a.name ?? a.email ?? '')).join('; ')}
            </div>
          )}
        </div>
      )}
      {blockers.length > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          <ul className="list-disc pl-4">
            {blockers.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-xs', isNonActivity ? 'text-gray-200' : 'text-gray-400 dark:text-gray-500')}>
          {startTime} · {durH}h
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={edit}
            disabled={busy}
            className={cn(isNonActivity && 'text-gray-100 hover:bg-gray-500 hover:text-white dark:text-gray-100 dark:hover:bg-gray-600 dark:hover:text-white')}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            {t('activity.suggested.edit')}
          </Button>
          {isNonActivity && onUnmarkNonActivity ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onUnmarkNonActivity(suggestion.outlookEventId)}
              disabled={busy}
              className="text-gray-100 hover:bg-gray-500 hover:text-white dark:text-gray-100 dark:hover:bg-gray-600 dark:hover:text-white"
              title={t('activity.non_activity.unmark_hint', 'Restore this meeting as a suggested activity')}
            >
              <CalendarOff className="mr-1 h-3.5 w-3.5" />
              {t('activity.non_activity.unmark', 'Mark as Activity')}
            </Button>
          ) : onMarkNonActivity && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onMarkNonActivity(suggestion.outlookEventId)}
              disabled={busy}
              title={t('activity.non_activity.mark_hint', 'Remove from list and gray out on the calendar')}
            >
              <CalendarOff className="mr-1 h-3.5 w-3.5" />
              {t('activity.non_activity.mark', 'Non-Activity')}
            </Button>
          )}
          {templates.length > 0 && (
            <div className="relative" ref={tplRef}>
              <Button ref={tplBtnRef} size="sm" variant="outline" onClick={() => setTplOpen((o) => !o)} disabled={busy || isNonActivity} title={isNonActivity ? t('activity.non_activity.approve_disabled', 'Marked as Non-Activity — restore to Activity to approve') : undefined}>
                <Bookmark className="mr-1 h-3.5 w-3.5" />
                {t('activity.suggested.approve_with_template')}
                <ChevronDown className="ml-1 h-3 w-3" />
              </Button>
              {tplOpen && tplRect && createPortal(
                <div
                  ref={tplPopRef}
                  className="fixed z-[100] min-w-[220px] rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
                  style={{ top: tplRect.top, right: tplRect.right }}
                >
                  <ul className="max-h-[min(24rem,calc(100vh-6rem))] overflow-y-auto py-1 text-sm">
                    {templates.map((tp) => (
                      <li key={tp.id}>
                        <button
                          type="button"
                          onClick={() => { setTplOpen(false); void approve(tp.id) }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                          <Bookmark className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                          <span className="truncate">{tp.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>,
                document.body,
              )}
            </div>
          )}
          <Button
            size="sm"
            onClick={() => approve()}
            disabled={busy || isNonActivity}
            title={isNonActivity ? t('activity.non_activity.approve_disabled', 'Marked as Non-Activity — restore to Activity to approve') : undefined}
          >
            {busy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Check className="mr-1 h-3.5 w-3.5" />}
            {t('activity.suggested.approve')}
          </Button>
        </div>
      </div>
    </div>
  )
}
