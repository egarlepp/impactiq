import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { NotebookPen, Send, Pencil, Trash2, Check, X, Briefcase, Building2, Megaphone, UserPlus, type LucideIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Dialog } from '../ui/dialog.js'
import { Button } from '../ui/button.js'
import { Textarea } from '../ui/textarea.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { MarkdownHelpPopover } from '../ui/markdown-help.js'
import { cn } from '../../lib/utils.js'
import { api } from '../../lib/api.js'
import { formatRelativeTime } from '../../lib/time.js'
import { useCrmProjects } from '../../store/evaluationSource.js'
import { useCrmLabelContext, crmApiBase } from '../../store/crmProvider.js'

interface NoteRow {
  id: string
  activityId: string
  activityTitle: string | null
  // v1.262.0: whether the underlying meeting is Private/Confidential in
  // Outlook — drives masking activityTitle to "Private meeting" wherever
  // it's shown. See CLAUDE.md §7 Private Meetings.
  activityIsPrivateMeeting?: boolean
  activityDate: string | null
  activityTypeName: string | null
  activityTypeColor: string | null
  activityTypeIcon: string | null
  crmWhatId: string | null
  crmWhatType: string | null
  crmWhatName: string | null
  crmWhoId: string | null
  crmWhoType: string | null
  crmWhoName: string | null
  body: string
  createdAt: string
  updatedAt: string
  createdBy: { userId: string | null; displayName: string | null }
  canEdit: boolean
}

type Scope = 'activity' | 'opportunity' | 'account' | 'campaign' | 'lead'

function sfIcon(type: string | null): LucideIcon | null {
  switch (type) {
    case 'Opportunity': return Briefcase
    case 'Account': return Building2
    case 'Campaign': return Megaphone
    case 'Lead': return UserPlus
    default: return null
  }
}

interface PanelProps {
  activityId: string
  teamId: string
  activityTitle: string
  activityTypeIcon: string | null
  activityTypeColor: string | null
  crmWhatId: string | null
  crmWhatType: 'Opportunity' | 'Account' | 'Campaign' | null
  crmWhatName: string | null
  crmWhoId: string | null
  crmWhoType: string | null
  crmWhoName: string | null
  // v1.254.2: the linked Project (Evaluations__c) — when a Project is
  // linked, the draft note can also be posted as a dated, prepended entry
  // to the Project's Engineer Notes field. Kept optional/nullable for
  // callers that don't have activity-type context handy.
  activityTypeName?: string | null
  crmRelatedType?: string | null
  crmRelatedId?: string | null
  // v1.307.0: the linked Opportunity's parent Account, snapshotted onto the
  // activity (see drizzle/schema.ts activities.crmAccountId — CLAUDE.md §9
  // v1.97.0). Lets "Post: Acct Notes" push to the right Account even when
  // the activity's own SF linkage is the Opportunity, not the Account
  // directly — same roll-up convention as this panel's own "By Account" tab
  // (hasAccount below), which already treats an Opp-linked activity as
  // belonging to its parent Account for VIEWING notes.
  crmAccountId?: string | null
  crmAccountName?: string | null
  disabled?: boolean
  onReload?: () => void
}

interface Props extends PanelProps {
  open: boolean
  onClose: () => void
}

export function NotesDrawer({ open, onClose, onReload, ...panelProps }: Props) {
  const { t } = useTranslation()
  // Defer parent reload until close. If we called onReload immediately
  // after a note create/edit/delete, the parent refetches activities,
  // which remounts this ActivityCard and unmounts the drawer mid-use.
  const [dirty, setDirty] = useState(false)

  function closeDrawer() {
    if (dirty) { onReload?.(); setDirty(false) }
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={closeDrawer}
      title={t('activity.notes.drawer_title', 'Notes')}
      titleIcon={NotebookPen}
    >
      {/* stopPropagation on the outer content div: the drawer is rendered
          as a child of the activity card whose onClick opens the Edit
          form. Without this, every click inside also opens the edit
          drawer. */}
      <div onClick={(e) => e.stopPropagation()}>
        <NotesPanel {...panelProps} onReload={() => setDirty(true)} />
      </div>
    </Dialog>
  )
}

// v1.254.2: extracted from NotesDrawer so the exact same scope tabs,
// draft entry, and note list can be embedded inline as the Activity
// drawer's own Notes tab (§ ActivityForm) — not just inside the
// standalone Dialog opened from the activity card's notes icon. Both
// callers get the Engineer Notes checkbox for free since it lives here.
export function NotesPanel({
  activityId, teamId,
  activityTitle, activityTypeIcon, activityTypeColor,
  crmWhatId, crmWhatType, crmWhatName,
  crmWhoId, crmWhoType, crmWhoName,
  crmRelatedType, crmRelatedId,
  crmAccountId, crmAccountName,
  disabled,
  onReload,
}: PanelProps) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [scope, setScope] = useState<Scope>('activity')
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // v1.254.2: "also post this draft note to the linked Project's Engineer
  // Notes field" — any activity with a Project (Evaluation-type record)
  // linked, not just the seeded "Eval Work" type. crmRelatedType/crmRelatedId
  // are only ever populated when an admin's per-activity-type Extras
  // config actually links an Eval-type SF object (see writeback.ts /
  // CLAUDE.md §7) — that's the real signal, not the activity type's name.
  // v1.259.1 fix: this used to also require activityTypeName === 'Eval
  // Work', which both hardcoded an activity type name (CLAUDE.md §21) and
  // hid the checkbox for any other team's type that Extras-links an Eval
  // object — ActivityForm's own create-mode checkbox never had this extra
  // gate, so the two surfaces disagreed on when the checkbox should show.
  // Fires on note submit, alongside (not instead of) the normal note add.
  const [postToEngineerNotes, setPostToEngineerNotes] = useState(false)
  const [engineerNotesError, setEngineerNotesError] = useState<string | null>(null)
  // v1.387.0: never offered while Projects are off.
  const crmProjects = useCrmProjects()
  const canPostEngineerNotes = crmProjects && !!crmRelatedType && !!crmRelatedId

  const hasOpp = crmWhatType === 'Opportunity' && !!crmWhatId
  const hasAccount = (crmWhatType === 'Account' && !!crmWhatId) || hasOpp
  const hasCampaign = crmWhatType === 'Campaign' && !!crmWhatId
  const hasLead = crmWhoType === 'Lead' && !!crmWhoId

  // v1.307.0: "Post: Opp Notes" / "Post: Acct Notes" — push this same draft
  // note to Salesforce as a ContentNote on the Opportunity and/or Account,
  // reusing the exact same POST /api/notes/:id/push pipeline My Notes' own
  // "Push to Salesforce" button already uses (same worker, same audit rows,
  // same dedupe, same Sync History visibility) rather than a second
  // implementation. Acct target rolls up through a linked Opportunity's
  // cached parent Account (crmAccountId/crmAccountName) — see PanelProps.
  const oppPushTarget = hasOpp && crmWhatId ? { crmType: 'Opportunity' as const, sfId: crmWhatId, sfName: crmWhatName ?? null } : null
  const directAcctPushTarget = crmWhatType === 'Account' && crmWhatId ? { crmType: 'Account' as const, sfId: crmWhatId, sfName: crmWhatName ?? null } : null
  const acctPushTarget = directAcctPushTarget ?? (hasOpp && crmAccountId ? { crmType: 'Account' as const, sfId: crmAccountId, sfName: crmAccountName ?? null } : null)
  const [postToOppNotes, setPostToOppNotes] = useState(false)
  const [postToAcctNotes, setPostToAcctNotes] = useState(false)
  const [sfNotesPushError, setSfNotesPushError] = useState<string | null>(null)

  const tabs: Array<{ key: Scope; icon: LucideIcon; label: string; enabled: boolean; disabledTip: string }> = [
    { key: 'activity', icon: NotebookPen, label: t('activity.notes.scope_activity', 'By Activity'), enabled: true, disabledTip: '' },
    { key: 'opportunity', icon: Briefcase, label: t('activity.notes.scope_opportunity', 'By Opportunity'), enabled: hasOpp, disabledTip: t('activity.notes.scope_disabled_no_opp', 'This activity is not linked to an Opportunity') },
    { key: 'account', icon: Building2, label: t('activity.notes.scope_account', 'By Account'), enabled: hasAccount, disabledTip: t('activity.notes.scope_disabled_no_account', 'This activity is not linked to an Account or Opportunity') },
    { key: 'campaign', icon: Megaphone, label: t('activity.notes.scope_campaign', 'By Campaign'), enabled: hasCampaign, disabledTip: t('activity.notes.scope_disabled_no_campaign', 'This activity is not linked to a Campaign') },
    { key: 'lead', icon: UserPlus, label: t('activity.notes.scope_lead', 'By Lead'), enabled: hasLead, disabledTip: t('activity.notes.scope_disabled_no_lead', 'This activity is not linked to a Lead') },
  ]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ scope })
    if (scope === 'activity') params.set('activityId', activityId)
    else if ((scope === 'opportunity' || scope === 'account' || scope === 'campaign') && crmWhatId) {
      params.set('crmWhatId', crmWhatId); params.set('teamId', teamId)
    } else if (scope === 'lead' && crmWhoId) {
      params.set('crmWhoId', crmWhoId); params.set('teamId', teamId)
    }
    api.get<NoteRow[]>(`/api/notes?${params.toString()}`).then((res) => {
      if (cancelled) return
      if (res.error) setError(res.error)
      else setNotes(res.data ?? [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [scope, activityId, crmWhatId, crmWhoId, teamId])

  async function submitNew() {
    if (!draft.trim() || scope !== 'activity') return
    const text = draft.trim()
    setSubmitting(true)
    setError(null)
    const res = await api.post<NoteRow>('/api/notes', { activityId, body: text })
    setSubmitting(false)
    if (res.error) { setError(res.error); return }

    // Engineer Notes prepend-update — a secondary, non-blocking write. The
    // note above has already saved and must not be undone by a Salesforce
    // failure here; any error is surfaced without losing the new note.
    if (postToEngineerNotes && canPostEngineerNotes && crmRelatedType && crmRelatedId) {
      const prependRes = await api.post(`${crmApiBase()}/field-prepend`, {
        teamId,
        sobject: crmRelatedType,
        appField: 'eval_engineer_notes',
        recordId: crmRelatedId,
        text,
      })
      if (prependRes.error) {
        // eslint-disable-next-line no-console
        console.warn('[engineer-notes] prepend failed:', prependRes.error)
        setEngineerNotesError(prependRes.error)
      } else {
        setPostToEngineerNotes(false)
        setEngineerNotesError(null)
      }
    }

    // Push to Salesforce as a ContentNote on the Opportunity and/or Account
    // — another secondary, non-blocking write. The note itself is already
    // saved above regardless of whether this succeeds.
    const pushTargets = [
      postToOppNotes && oppPushTarget ? oppPushTarget : null,
      postToAcctNotes && acctPushTarget ? acctPushTarget : null,
    ].filter((t): t is NonNullable<typeof t> => t !== null)
    if (pushTargets.length > 0 && res.data) {
      const pushRes = await api.post(`/api/notes/${res.data.id}/push`, { targets: pushTargets })
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

    setDraft('')
    const params = new URLSearchParams({ scope: 'activity', activityId })
    const list = await api.get<NoteRow[]>(`/api/notes?${params.toString()}`)
    setNotes(list.data ?? [])
    onReload?.()
  }

  async function updateNote(id: string, body: string) {
    const res = await api.patch<NoteRow>(`/api/notes/${id}`, { body })
    if (res.error) return
    setNotes((n) => n.map((r) => r.id === id ? { ...r, body: res.data?.body ?? body, updatedAt: res.data?.updatedAt ?? new Date().toISOString() } : r))
    onReload?.()
  }

  async function deleteNote(id: string) {
    if (!window.confirm(t('activity.notes.delete_confirm', 'Delete this note?'))) return
    const res = await api.delete(`/api/notes/${id}`)
    if (res.error) return
    setNotes((n) => n.filter((r) => r.id !== id))
    onReload?.()
  }

  // Bold "what am I looking at" header — one line, icon + name.
  function renderContextHeader() {
    if (scope === 'activity') {
      return (
        <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {activityTypeIcon && (
            <DynamicIcon
              name={activityTypeIcon}
              className="h-4 w-4 shrink-0"
              {...(activityTypeColor ? { style: { color: activityTypeColor } } : {})}
            />
          )}
          <span>{activityTitle}</span>
        </div>
      )
    }
    let Icon: LucideIcon = Building2
    let name: string | null = null
    if (scope === 'opportunity') { Icon = Briefcase; name = crmWhatName }
    else if (scope === 'account') { Icon = Building2; name = crmWhatType === 'Account' ? crmWhatName : t('activity.notes.account_via_opp', 'Account') }
    else if (scope === 'campaign') { Icon = Megaphone; name = crmWhatName }
    else if (scope === 'lead') { Icon = UserPlus; name = crmWhoName }
    if (!name) return null
    return (
      <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Icon className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
        <span>{name}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Scope tabs — data-driven so all five render the same. */}
      <div className="inline-flex flex-wrap gap-0 self-start overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
        {tabs.map(({ key, icon: TabIcon, label, enabled, disabledTip }) => (
          <button
            key={key}
            type="button"
            onClick={() => enabled && setScope(key)}
            disabled={!enabled}
            title={enabled ? undefined : disabledTip}
            className={cn(
              'inline-flex items-center gap-1 border-r border-gray-200 px-2.5 py-1 text-xs last:border-r-0 disabled:opacity-40 dark:border-gray-700',
              scope === key
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800',
            )}
          >
            <TabIcon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>

      {/* Bold context chip — what the current scope is rolling up. */}
      {renderContextHeader()}

      {/* Draft entry — only when adding to a specific activity */}
      {scope === 'activity' && (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('activity.notes.draft_placeholder', 'Add a note… (Markdown supported)')}
            rows={4}
            disabled={disabled}
          />
          {canPostEngineerNotes && (
            <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={postToEngineerNotes}
                onChange={(e) => { setPostToEngineerNotes(e.target.checked); setEngineerNotesError(null) }}
                disabled={disabled}
                className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 dark:border-gray-600"
              />
              {t('activity.form.post_to_engineer_notes', 'Also post this to Engineer Notes on the linked Project')}
            </label>
          )}
          {engineerNotesError && (
            <p className="text-[10px] text-red-600 dark:text-red-400">{engineerNotesError.startsWith('errors.') ? t(engineerNotesError) : engineerNotesError}</p>
          )}
          {/* v1.307.0: same "Push to Salesforce" ContentNote mechanism as My
              Notes' own Push button — see oppPushTarget/acctPushTarget above.
              Shown independently per target so a note on an Opp-only-linked
              activity can still push to the Account (or vice versa).
              v1.308.1: same row, each with a hover tooltip explaining what
              it actually does — two checkboxes with near-identical labels
              stacked vertically read as one confusing group otherwise. */}
          {(oppPushTarget || acctPushTarget) && (
            <div className="flex items-center gap-3">
              {oppPushTarget && (
                <label
                  className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400"
                  title={t('activity.notes.post_to_opp_notes_tip', { context: crmCtx })}
                >
                  <input
                    type="checkbox"
                    checked={postToOppNotes}
                    onChange={(e) => { setPostToOppNotes(e.target.checked); setSfNotesPushError(null) }}
                    disabled={disabled}
                    className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 dark:border-gray-600"
                  />
                  {t('activity.notes.post_to_opp_notes', { context: crmCtx })}
                </label>
              )}
              {acctPushTarget && (
                <label
                  className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400"
                  title={t('activity.notes.post_to_acct_notes_tip', { context: crmCtx })}
                >
                  <input
                    type="checkbox"
                    checked={postToAcctNotes}
                    onChange={(e) => { setPostToAcctNotes(e.target.checked); setSfNotesPushError(null) }}
                    disabled={disabled}
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
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={submitNew}
              disabled={!draft.trim() || submitting || disabled}
            >
              {submitting ? <Spinner className="mr-1 h-3 w-3" /> : <Send className="mr-1 h-3 w-3" />}
              {t('activity.notes.submit', 'Add note')}
            </Button>
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
              {t('activity.notes.markdown_hint', 'Supports **bold**, _italic_, `code`, lists.')}
              <MarkdownHelpPopover />
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>
      )}

      {!loading && notes.length === 0 && (
        <p className="rounded-md border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
          {scope === 'activity'
            ? t('activity.notes.empty_activity', 'No notes yet. Add the first one above.')
            : scope === 'opportunity'
            ? t('activity.notes.empty_opportunity', 'No notes on any activity linked to this Opportunity yet.')
            : scope === 'account'
            ? t('activity.notes.empty_account', 'No notes on any activity linked to this Account yet.')
            : scope === 'campaign'
            ? t('activity.notes.empty_campaign', 'No notes on any activity linked to this Campaign yet.')
            : t('activity.notes.empty_lead', 'No notes on any activity linked to this Lead yet.')}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {notes.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            scope={scope}
            onEdit={(newBody) => updateNote(n.id, newBody)}
            onDelete={() => deleteNote(n.id)}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

interface NoteCardProps {
  note: NoteRow
  scope: Scope
  onEdit: (body: string) => Promise<void>
  onDelete: () => Promise<void>
  t: TFunction
}

function NoteCard({ note, scope, onEdit, onDelete, t }: NoteCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const bodyLines = note.body.split('\n')
  const isLong = bodyLines.length > 5
  const collapsed = !expanded && isLong

  // On the Account rollup, rows whose source activity linked to an
  // Opportunity get an inline chip so the reader knows which Opp this
  // came from. Direct Account-linked rows show nothing extra.
  const showSourceChip = scope === 'account' && note.crmWhatType === 'Opportunity' && note.crmWhatName
  const SourceIcon = showSourceChip ? sfIcon(note.crmWhatType) : null

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="font-medium text-gray-800 dark:text-gray-100">
            {note.createdBy.displayName ?? <span className="italic text-gray-400">{t('activity.notes.deleted_user', 'Deleted user')}</span>}
          </span>
          <span className="text-[10px] text-gray-500 dark:text-gray-400" title={new Date(note.createdAt).toLocaleString()}>
            {formatRelativeTime(note.createdAt, t)}
            {note.updatedAt !== note.createdAt && (
              <span className="ml-1 italic">· {t('activity.notes.edited', 'edited')}</span>
            )}
          </span>
          {scope !== 'activity' && note.activityTitle && (
            <span className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
              <span className="opacity-70">{t('activity.notes.on', 'on')}</span>
              {note.activityTypeIcon && (
                <DynamicIcon
                  name={note.activityTypeIcon}
                  className="h-3 w-3 shrink-0"
                  {...(note.activityTypeColor ? { style: { color: note.activityTypeColor } } : {})}
                />
              )}
              <span className="font-medium text-gray-700 dark:text-gray-200">
                {note.activityIsPrivateMeeting ? t('activity.private_meeting.title', 'Private meeting') : note.activityTitle}
              </span>
              {note.activityDate && (
                <span title={note.activityDate}>· {new Date(note.activityDate).toLocaleDateString()}</span>
              )}
              {showSourceChip && SourceIcon && (
                <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[9px] font-medium text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  <SourceIcon className="h-2.5 w-2.5" />
                  {note.crmWhatName}
                </span>
              )}
            </span>
          )}
        </div>
        {note.canEdit && !editing && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => { setEditing(true); setDraft(note.body) }}
              className="rounded p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
              aria-label={t('activity.notes.edit', 'Edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
              aria-label={t('activity.notes.delete', 'Delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {editing && (
          <Badge variant="warning" className="text-[9px]">{t('activity.notes.editing', 'Editing')}</Badge>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={async () => { await onEdit(draft.trim()); setEditing(false) }}
              disabled={!draft.trim() || draft.trim() === note.body.trim()}
            >
              <Check className="mr-1 h-3 w-3" />
              {t('common.save', 'Save')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              <X className="mr-1 h-3 w-3" />
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={cn('md-body text-gray-700 dark:text-gray-200', collapsed && 'line-clamp-5')}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{note.body}</ReactMarkdown>
          </div>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[10px] font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {expanded ? t('activity.notes.show_less', 'Show less') : t('activity.notes.show_more', 'Show more')}
            </button>
          )}
        </>
      )}
    </div>
  )
}
