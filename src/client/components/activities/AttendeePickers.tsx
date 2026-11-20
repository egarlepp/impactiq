import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, ChevronDown, BookUser, Contact } from 'lucide-react'
import { Input } from '../ui/input.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { crmApiBaseFor, useCrmLabelContext, useCrmProvider } from '../../store/crmProvider.js'

// v1.416.0: the CRM contact search used to add attendees and pick a meeting owner, moved unchanged out of ActivityForm.tsx.

export interface SfContactRow { Id: string; Name: string; Email: string | null; Title: string | null; AccountName: string | null }

// Searches SF contacts filtered by the linked Account (or the Account behind
// the linked Opportunity). Clicking a hit appends it to the activity's
// attendees list. Debounced; skips duplicate emails silently.
// v1.246.0: single toggle row for the Attendees section's two Salesforce
// searches (previously two separate always-visible rows — see the call
// site's comment). A blue-highlighted two-icon toggle picks which search is
// active; the text link to its right opens/closes that search's own
// dropdown exactly as it always did. The "on this Account" option only
// appears once an Opportunity or Account is linked — same precondition the
// two rows individually had before — and falls back to the global search if
// that option disappears (SF Link cleared or changed to a Lead) while it was
// selected, so the toggle never points at a search with nothing to run.
export function AttendeeSfSearchBar({
  hasAccountOption,
  onPickGlobal,
  accountProps,
}: {
  hasAccountOption: boolean
  onPickGlobal: (c: { name: string; email: string | null }) => void
  accountProps: {
    linkedId: string
    linkedType: 'Opportunity' | 'Account'
    existing: { name?: string; email?: string }[]
    onAdd: (c: { name: string; email: string | null }) => void
  } | null
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [mode, setMode] = useState<'global' | 'account'>('global')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (mode === 'account' && !hasAccountOption) setMode('global')
  }, [mode, hasAccountOption])

  const label = mode === 'account'
    ? t('activity.form.attendees_sf_search', { context: crmCtx, defaultValue: 'Search Salesforce contacts on this Account' })
    : t('activity.form.attendees_sf_search_global', { context: crmCtx, defaultValue: 'Search Salesforce contacts & users' })

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex shrink-0 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setMode('global')}
            aria-pressed={mode === 'global'}
            title={t('activity.form.attendees_sf_toggle_global', { context: crmCtx, defaultValue: 'Search All Salesforce Contacts & Users' })}
            aria-label={t('activity.form.attendees_sf_toggle_global', { context: crmCtx, defaultValue: 'Search All Salesforce Contacts & Users' })}
            className={cn(
              'flex h-7 w-8 items-center justify-center transition-colors',
              mode === 'global'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
            )}
          >
            <BookUser className="h-3.5 w-3.5" />
          </button>
          {hasAccountOption && (
            <button
              type="button"
              onClick={() => setMode('account')}
              aria-pressed={mode === 'account'}
              title={t('activity.form.attendees_sf_toggle_account', { context: crmCtx, defaultValue: 'Search Salesforce Contacts on Account' })}
              aria-label={t('activity.form.attendees_sf_toggle_account', { context: crmCtx, defaultValue: 'Search Salesforce Contacts on Account' })}
              className={cn(
                'flex h-7 w-8 items-center justify-center border-l border-gray-200 transition-colors dark:border-gray-700',
                mode === 'account'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
              )}
            >
              <Contact className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
          {label}
        </button>
      </div>
      {open && mode === 'global' && (
        <SfContactOwnerPicker hideTrigger onPick={onPickGlobal} onAfterPick={() => setOpen(false)} />
      )}
      {open && mode === 'account' && accountProps && (
        <SfContactAttendeePicker hideTrigger {...accountProps} />
      )}
    </div>
  )
}

export function SfContactAttendeePicker({
  linkedId,
  linkedType,
  existing,
  onAdd,
  hideTrigger = false,
}: {
  linkedId: string
  linkedType: 'Opportunity' | 'Account'
  existing: { name?: string; email?: string }[]
  onAdd: (c: { name: string; email: string | null }) => void
  // v1.246.0: mounted by AttendeeSfSearchBar with its own toggle+link already
  // rendered — this becomes a body-only render, always "open" for as long as
  // the parent keeps it mounted. Defaults to false so this component's
  // original self-contained behavior (own trigger button, own open state) is
  // completely unchanged for any other caller.
  hideTrigger?: boolean
}) {
  const { t } = useTranslation()
  const crmProvider = useCrmProvider()
  const crmCtx = useCrmLabelContext()
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<SfContactRow[]>([])
  const [loading, setLoading] = useState(false)
  const [openState, setOpenState] = useState(false)
  const open = hideTrigger ? true : openState
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      const params = new URLSearchParams({ q, kind: linkedType === 'Opportunity' ? 'opportunity' : 'account' })
      const res = await api.get<SfContactRow[]>(`${crmApiBaseFor(crmProvider)}/accounts/${encodeURIComponent(linkedId)}/contacts?${params.toString()}`)
      setRows(res.data ?? [])
      setLoading(false)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [q, open, linkedId, linkedType, crmProvider])

  const existingEmails = new Set(existing.map((a) => a.email?.toLowerCase()).filter(Boolean) as string[])

  const body = (
    <div className="flex flex-col gap-1.5">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('activity.form.attendees_sf_search_placeholder', 'Type a name or email…')}
        className="h-8 text-xs"
      />
      <div className="max-h-40 overflow-y-auto rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {loading && <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>}
        {!loading && rows.length === 0 && (
          <p className="px-2 py-2 text-center text-xs text-gray-400">{t('sf.no_results')}</p>
        )}
        {rows.map((c) => {
          const already = c.Email ? existingEmails.has(c.Email.toLowerCase()) : false
          return (
            <button
              key={c.Id}
              type="button"
              disabled={already}
              onClick={() => onAdd({ name: c.Name, email: c.Email })}
              className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-gray-50 disabled:opacity-40 dark:hover:bg-gray-800"
            >
              <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                {c.Name}
                {already && <span className="ml-1 text-[10px] text-gray-400">({t('activity.form.attendees_sf_already_added', 'already added')})</span>}
              </span>
              {(c.Title || c.Email) && (
                <span className="text-[10px] text-gray-500 dark:text-gray-400">
                  {[c.Title, c.Email].filter(Boolean).join(' · ')}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )

  if (hideTrigger) {
    return (
      <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-dashed border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-gray-800/50">
        {body}
      </div>
    )
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-dashed border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-gray-800/50">
      <button
        type="button"
        onClick={() => setOpenState((v) => !v)}
        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
        {t('activity.form.attendees_sf_search', { context: crmCtx, defaultValue: 'Search Salesforce contacts on this Account' })}
      </button>
      {open && body}
    </div>
  )
}

export interface SfUserRow { Id: string; Name: string; Email: string | null }

// Meeting-owner picker: searches Salesforce Contacts AND SF Users in
// parallel, groups results by type in the dropdown. Independent of
// sfSelection so the owner can be picked even before an SF Link is
// chosen.
export function SfContactOwnerPicker({
  onPick,
  label,
  hideTrigger = false,
  onAfterPick,
}: {
  onPick: (c: { name: string; email: string | null }) => void
  label?: string
  // v1.246.0: same controlled-body pattern as SfContactAttendeePicker above —
  // defaults to false so the Meeting owner search (this component's other,
  // unrelated call site) keeps its own trigger button and open state
  // untouched.
  hideTrigger?: boolean
  // Fires right after a contact/user is picked, in addition to this
  // component's own "collapse and clear the query" reset. Meaningless when
  // hideTrigger is false (that reset already collapses the box itself);
  // AttendeeSfSearchBar uses it to collapse ITS row when hideTrigger is
  // true, since this component has no open state of its own to collapse in
  // that mode. Preserves the pre-v1.246.0 behavior where picking a global
  // contact in the Attendees section closed the box.
  onAfterPick?: () => void
}) {
  const { t } = useTranslation()
  const crmProvider = useCrmProvider()
  const crmCtx = useCrmLabelContext()
  const [q, setQ] = useState('')
  const [contacts, setContacts] = useState<SfContactRow[]>([])
  const [crmUsers, setSfUsers] = useState<SfUserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [openState, setOpenState] = useState(false)
  const open = hideTrigger ? true : openState
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    if (q.trim().length < 2) { setContacts([]); setSfUsers([]); setLoading(false); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      // Salesforce also searches its own Users; other CRMs search contacts only.
      const [cRes, uRes] = await Promise.all([
        api.get<SfContactRow[]>(`${crmApiBaseFor(crmProvider)}/search/contacts?q=${encodeURIComponent(q)}`),
        crmProvider === 'salesforce'
          ? api.get<SfUserRow[]>(`/api/salesforce/search/users?q=${encodeURIComponent(q)}`)
          : Promise.resolve({ data: [] as SfUserRow[] }),
      ])
      setContacts(cRes.data ?? [])
      setSfUsers(uRes.data ?? [])
      setLoading(false)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [q, open, crmProvider])

  const hasResults = contacts.length > 0 || crmUsers.length > 0

  const body = (
    <div className="flex flex-col gap-1.5">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('activity.form.attendees_sf_search_placeholder', 'Type a name or email…')}
        className="h-8 text-xs"
      />
      <div className="max-h-64 overflow-y-auto rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {loading && <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>}
        {!loading && !hasResults && (
          <p className="px-2 py-2 text-center text-xs text-gray-400">{t('sf.no_results')}</p>
        )}
        {contacts.length > 0 && (
          <div>
            <div className="sticky top-0 z-10 bg-gray-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {t('activity.form.owner_group_contacts', 'Contacts')} ({contacts.length})
            </div>
            {contacts.map((c) => (
              <button
                key={`c-${c.Id}`}
                type="button"
                onClick={() => { onPick({ name: c.Name, email: c.Email }); setOpenState(false); setQ(''); onAfterPick?.() }}
                className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">{c.Name}</span>
                {(c.Title || c.Email) && (
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">
                    {[c.Title, c.Email].filter(Boolean).join(' · ')}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {crmUsers.length > 0 && (
          <div>
            <div className="sticky top-0 z-10 bg-gray-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {t('activity.form.owner_group_users', 'Salesforce Users')} ({crmUsers.length})
            </div>
            {crmUsers.map((u) => (
              <button
                key={`u-${u.Id}`}
                type="button"
                onClick={() => { onPick({ name: u.Name, email: u.Email }); setOpenState(false); setQ(''); onAfterPick?.() }}
                className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">{u.Name}</span>
                {u.Email && (
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">{u.Email}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  if (hideTrigger) {
    return (
      <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-dashed border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-gray-800/50">
        {body}
      </div>
    )
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-dashed border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-gray-800/50">
      <button
        type="button"
        onClick={() => setOpenState((v) => !v)}
        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
        {label ?? t('activity.form.meeting_owner_sf_search', { context: crmCtx, defaultValue: 'Search Salesforce contacts for owner' })}
      </button>
      {open && body}
    </div>
  )
}
