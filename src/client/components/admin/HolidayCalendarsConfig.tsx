import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Save as SaveIcon, ChevronDown, ChevronRight, Plus, Trash2, Users2, UserRound, RefreshCw, X } from 'lucide-react'
import { Input } from '../ui/input.js'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'

interface CalendarRow { id: string; code: string; name: string; locale: string; isActive: boolean; dateCount: number }
interface HolidayDate { id: string; calendarId: string; date: string; name: string }
interface AssignmentRow { userId: string; calendarId: string; userEmail: string; userDisplayName: string }
interface UserRow { id: string; email: string; displayName: string }
interface TeamRow { id: string; name: string }

export function HolidayCalendarsConfig() {
  const { t } = useTranslation()
  const [cals, setCals] = useState<CalendarRow[]>([])
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedCal, setExpandedCal] = useState<string | null>(null)
  const [expandedDates, setExpandedDates] = useState<Record<string, HolidayDate[]>>({})
  const [savingUser, setSavingUser] = useState<string | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [teamAssignments, setTeamAssignments] = useState<Record<string, string[]>>({})
  const [savingTeam, setSavingTeam] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    const [calRes, assignRes, userRes, teamRes] = await Promise.all([
      api.get<CalendarRow[]>('/api/admin/holiday-calendars'),
      api.get<AssignmentRow[]>('/api/admin/holiday-calendars/assignments'),
      api.get<UserRow[]>('/api/admin/users'),
      api.get<TeamRow[]>('/api/admin/teams'),
    ])
    setCals(calRes.data ?? [])
    setAssignments(assignRes.data ?? [])
    setUsers(userRes.data ?? [])
    setTeams(teamRes.data ?? [])
    // Fetch team assignments lazily-parallel.
    const teamAssigns: Record<string, string[]> = {}
    await Promise.all((teamRes.data ?? []).map(async (tm) => {
      const r = await api.get<string[]>(`/api/admin/teams/${tm.id}/holiday-calendars`)
      teamAssigns[tm.id] = r.data ?? []
    }))
    setTeamAssignments(teamAssigns)
    setLoading(false)
  }

  async function saveTeamAssignments(teamId: string, calendarIds: string[]) {
    setSavingTeam(teamId)
    await api.put(`/api/admin/teams/${teamId}/holiday-calendars`, { calendarIds })
    setSavingTeam(null)
    await reload()
  }
  useEffect(() => { void reload() }, [])

  async function expandCalendar(id: string) {
    if (expandedCal === id) { setExpandedCal(null); return }
    setExpandedCal(id)
    if (!expandedDates[id]) {
      const res = await api.get<HolidayDate[]>(`/api/admin/holiday-calendars/${id}/dates`)
      setExpandedDates((prev) => ({ ...prev, [id]: res.data ?? [] }))
    }
  }

  function assignedFor(userId: string): string[] {
    return assignments.filter((a) => a.userId === userId).map((a) => a.calendarId)
  }

  async function saveAssignments(userId: string, calendarIds: string[]) {
    setSavingUser(userId)
    await api.put(`/api/admin/holiday-calendars/assignments/${userId}`, { calendarIds })
    setSavingUser(null)
    await reload()
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.calendars.library_title')}</h2>
          <div className="ml-auto flex items-center gap-2">
            <RefreshAllButton onDone={reload} />
            <NewCalendarButton onCreated={reload} />
          </div>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t('admin.calendars.library_description')}</p>
        <div className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          {cals.map((c) => {
            const isCountry = /^[A-Z]{2}$/.test(c.code)
            return (
              <div key={c.id}>
                <div className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <button
                    type="button"
                    onClick={() => expandCalendar(c.id)}
                    className="flex flex-1 items-center gap-2"
                  >
                    {expandedCal === c.id ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />}
                    <span className="font-medium text-gray-800 dark:text-gray-100">{c.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${isCountry ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'}`}>{c.code}</span>
                    {!isCountry && <span className="text-[10px] italic text-gray-400">{t('admin.calendars.custom_badge', 'custom')}</span>}
                  </button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{c.dateCount} {t('admin.calendars.dates')}</span>
                  {isCountry && <RefreshOneButton calendarId={c.id} onDone={reload} />}
                  <DeleteCalendarButton calendarId={c.id} calendarName={c.name} onDeleted={reload} />
                </div>
                {expandedCal === c.id && (
                  <CalendarDatesEditor
                    calendarId={c.id}
                    dates={expandedDates[c.id] ?? []}
                    onChange={async () => {
                      const res = await api.get<HolidayDate[]>(`/api/admin/holiday-calendars/${c.id}/dates`)
                      setExpandedDates((prev) => ({ ...prev, [c.id]: res.data ?? [] }))
                      void reload()
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <Users2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.calendars.team_assignments_title')}</h2>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t('admin.calendars.team_assignments_description')}</p>
        <div className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          {teams.map((tm) => (
            <AssignmentRow
              key={tm.id}
              label={tm.name}
              sublabel={null}
              assigned={teamAssignments[tm.id] ?? []}
              cals={cals}
              saving={savingTeam === tm.id}
              onSave={(ids) => saveTeamAssignments(tm.id, ids)}
            />
          ))}
          {teams.length === 0 && (
            <p className="px-3 py-3 text-xs text-gray-400">{t('admin.calendars.no_teams')}</p>
          )}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <UserRound className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.calendars.assignments_title')}</h2>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t('admin.calendars.assignments_description')}</p>
        <div className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          {users.map((u) => {
            const assigned = assignedFor(u.id)
            return (
              <AssignmentRow
                key={u.id}
                label={u.displayName}
                sublabel={u.email}
                assigned={assigned}
                cals={cals}
                saving={savingUser === u.id}
                onSave={(ids) => saveAssignments(u.id, ids)}
              />
            )
          })}
          {users.length === 0 && (
            <p className="px-3 py-3 text-xs text-gray-400">{t('admin.calendars.no_users')}</p>
          )}
        </div>
      </section>
    </div>
  )
}

function CalendarDatesEditor({ calendarId, dates, onChange }: {
  calendarId: string
  dates: HolidayDate[]
  onChange: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  async function add() {
    if (!newDate || !newName.trim()) return
    setBusy(true)
    await api.post(`/api/admin/holiday-calendars/${calendarId}/dates`, { date: newDate, name: newName.trim() })
    setBusy(false)
    setNewDate(''); setNewName('')
    await onChange()
  }
  async function remove(dateId: string) {
    setBusy(true)
    await api.delete(`/api/admin/holiday-calendars/${calendarId}/dates/${dateId}`)
    setBusy(false)
    await onChange()
  }
  return (
    <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-800/40">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.calendars.date')}</label>
          <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="h-8 w-40 text-xs" />
        </div>
        <div className="flex flex-1 min-w-[160px] flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.calendars.name_label')}</label>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('admin.calendars.name_placeholder')} className="h-8 text-xs" />
        </div>
        <Button size="sm" onClick={add} disabled={!newDate || !newName.trim() || busy}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('admin.calendars.add_date')}
        </Button>
      </div>
      {dates.length === 0 ? (
        <p className="text-xs text-gray-400">…</p>
      ) : (
        <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-gray-700 dark:text-gray-300 md:grid-cols-2">
          {dates.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-white dark:hover:bg-gray-900">
              <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">{d.date}</span>
              <span className="flex-1 truncate">{d.name}</span>
              <button
                type="button"
                onClick={() => remove(d.id)}
                className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                aria-label={t('common.delete')}
                disabled={busy}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AssignmentRow({ label, sublabel, assigned, cals, saving, onSave }: {
  label: string
  sublabel: string | null
  assigned: string[]
  cals: CalendarRow[]
  saving: boolean
  onSave: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<string[]>(assigned)
  useEffect(() => { setPicked(assigned) }, [assigned.join(',')])
  const dirty = picked.slice().sort().join(',') !== assigned.slice().sort().join(',')
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-[180px]">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{label}</p>
        {sublabel && <p className="text-[11px] text-gray-500 dark:text-gray-400">{sublabel}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {cals.map((c) => {
          const on = picked.includes(c.id)
          const disabled = !on && picked.length >= 3
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setPicked((prev) => {
                if (on) return prev.filter((x) => x !== c.id)
                if (prev.length >= 3) return prev
                return [...prev, c.id]
              })}
              disabled={disabled}
              className={
                'rounded-md border px-2 py-0.5 text-[11px] transition-colors ' +
                (on
                  ? 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500'
                  : disabled
                    ? 'border-gray-200 bg-gray-50 text-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-600'
                    : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700')
              }
            >
              {c.code.toUpperCase()}
            </button>
          )
        })}
        <span className="text-[10px] text-gray-400">{picked.length}/3</span>
      </div>
      <Button size="sm" onClick={() => onSave(picked)} disabled={!dirty || saving}>
        {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}
        {t('common.save')}
      </Button>
    </div>
  )
}

// Refresh every ISO-country calendar for the current + next year against
// the public Nager holiday feed. Custom calendars are left alone.
function RefreshAllButton({ onDone }: { onDone: () => void | Promise<void> }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function run() {
    setBusy(true); setMsg(null)
    const res = await api.post<{ years: number[]; results: Array<{ code: string; added: number; replaced: number; error?: string }> }>('/api/admin/holiday-calendars/refresh', {})
    setBusy(false)
    if (res.error) { setMsg(res.error); return }
    const succeeded = (res.data?.results ?? []).filter((r) => !r.error).length
    const failed = (res.data?.results ?? []).filter((r) => r.error).length
    setMsg(t('admin.calendars.refresh_done', '{{ok}} refreshed, {{fail}} failed', { ok: succeeded, fail: failed }))
    void onDone()
    setTimeout(() => setMsg(null), 5000)
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={run} disabled={busy} title={t('admin.calendars.refresh_hint', 'Pull fresh public-holiday dates for the current and next year')}>
        {busy ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
        {t('admin.calendars.refresh', 'Refresh')}
      </Button>
      {msg && <span className="text-[11px] text-gray-500 dark:text-gray-400">{msg}</span>}
    </>
  )
}

function RefreshOneButton({ calendarId, onDone }: { calendarId: string; onDone: () => void | Promise<void> }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  async function run(e: React.MouseEvent) {
    e.stopPropagation()
    setBusy(true)
    await api.post(`/api/admin/holiday-calendars/${calendarId}/refresh`, {})
    setBusy(false)
    void onDone()
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      title={t('admin.calendars.refresh_one', 'Refresh this calendar from the public feed')}
    >
      {busy ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
    </button>
  )
}

function DeleteCalendarButton({ calendarId, calendarName, onDeleted }: { calendarId: string; calendarName: string; onDeleted: () => void | Promise<void> }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  async function run(e: React.MouseEvent) {
    e.stopPropagation()
    if (!window.confirm(t('admin.calendars.delete_confirm', 'Delete calendar "{{name}}"? This removes all its dates and any user/team assignments to it.', { name: calendarName }))) return
    setBusy(true)
    await api.delete(`/api/admin/holiday-calendars/${calendarId}`)
    setBusy(false)
    void onDeleted()
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      title={t('admin.calendars.delete', 'Delete calendar')}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  )
}

function NewCalendarButton({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [locale, setLocale] = useState('en-US')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setBusy(true); setErr(null)
    const res = await api.post<{ id: string }>('/api/admin/holiday-calendars', { code, name, locale })
    setBusy(false)
    if (res.error) { setErr(res.error); return }
    setOpen(false); setCode(''); setName(''); setLocale('en-US')
    void onCreated()
  }

  if (!open) return (
    <Button size="sm" onClick={() => setOpen(true)}>
      <Plus className="mr-1 h-3.5 w-3.5" />
      {t('admin.calendars.add_calendar', 'Add calendar')}
    </Button>
  )
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('admin.calendars.add_calendar_title', 'New holiday calendar')}</h3>
          <button onClick={() => setOpen(false)} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X className="h-4 w-4" /></button>
        </div>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.calendars.add_calendar_hint', 'Use a country code (US, GB, DE, …) to pull public holidays via Refresh, or a custom code (e.g. "biz-closures") for company-specific days off.')}
        </p>
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.calendars.field_code', 'Code')}</label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="US / biz-closures" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.calendars.field_locale', 'Locale')}</label>
            <Input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="en-US" />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.calendars.field_name', 'Name')}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company closures" />
          </div>
        </div>
        {err && <p className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={submit} disabled={busy || !code.trim() || !name.trim()}>
            {busy ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
