import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleSlash, Eye, CheckCircle2, Circle } from 'lucide-react'
import { Spinner } from '../ui/spinner.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { SingleSelect } from '../ui/single-select.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'

type ReviewStatus = 'ignore' | 'will_watch' | 'addressed'

interface Row {
  id: string
  title: string
  startDatetime: string
  submittedAt: string | null
  createdAt: string
  meetingTypeReason: string
  status: ReviewStatus | null
  reviewedAt: string | null
  userId: string
  userName: string
  userEmail: string
  teamName: string
  reviewedByName: string | null
}

const STATUS_META: Record<ReviewStatus, { Icon: ComponentType<{ className?: string }>; activeClass: string }> = {
  ignore: { Icon: CircleSlash, activeClass: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200' },
  will_watch: { Icon: Eye, activeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
  addressed: { Icon: CheckCircle2, activeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
}

// v1.258.0: Admin → Monitoring → Activity Health. A triage queue for the
// optional "Why Meeting?" text captured on the Log Activity form (§7 —
// activities.meetingTypeReason). Product research per the PRD roadmap: this
// page is how an App Admin actually sees whether recurring reasons point at
// a need for a more specific activity type, and tracks their own review of
// each one (Ignore / Will Watch / Addressed) so the queue can be worked down
// over time instead of re-read from scratch every visit.
export function ActivityHealth() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  async function reload() {
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('status', statusFilter)
    const res = await api.get<Row[]>(`/api/admin/activity-health?${params.toString()}`)
    setRows(res.data ?? [])
  }
  useEffect(() => { void reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter])

  async function setStatus(id: string, status: ReviewStatus) {
    // Re-clicking the already-active button is a no-op — there's nothing to
    // change, and the server has no "unset back to New" state to move to.
    const row = rows?.find((r) => r.id === id)
    if (row?.status === status) return
    setBusyId(id)
    setRows((prev) => prev?.map((r) => r.id === id ? { ...r, status } : r) ?? prev)
    await api.patch(`/api/admin/activity-health/${id}`, { status })
    setBusyId(null)
    await reload()
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!rows) return []
    if (!needle) return rows
    return rows.filter((r) =>
      r.userName.toLowerCase().includes(needle) ||
      r.userEmail.toLowerCase().includes(needle) ||
      r.title.toLowerCase().includes(needle) ||
      r.meetingTypeReason.toLowerCase().includes(needle) ||
      r.teamName.toLowerCase().includes(needle),
    )
  }, [rows, q])

  const statusOptions = [
    { value: 'all', label: t('admin.activity_health.filter_all', 'All') },
    { value: 'new', label: t('admin.activity_health.status_new', 'New') },
    { value: 'ignore', label: t('admin.activity_health.action_ignore', 'Ignore') },
    { value: 'will_watch', label: t('admin.activity_health.action_will_watch', 'Will Watch') },
    { value: 'addressed', label: t('admin.activity_health.action_addressed', 'Addressed') },
  ]

  if (!rows) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('admin.activity_health.description', 'Contributors who chose "Meeting" and told us why. Use this to decide whether recurring reasons point at a need for a more specific activity type.')}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Label>{t('admin.activity_health.filter_label', 'Search')}</Label>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.activity_health.filter_placeholder', 'Filter by user, team, activity, or reason...')} />
        </div>
        <SingleSelect
          label={t('admin.activity_health.status_label', 'Status')}
          options={statusOptions}
          value={statusFilter}
          onChange={setStatusFilter}
        />
      </div>

      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.activity_health.empty', 'No "Why Meeting?" reasons captured yet.')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm text-gray-900 dark:text-gray-100">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">{t('admin.activity_health.col_user', 'User')}</th>
                <th className="px-3 py-2">{t('admin.activity_health.col_submitted', 'Submitted')}</th>
                <th className="px-3 py-2">{t('admin.activity_health.col_activity', 'Activity')}</th>
                <th className="px-3 py-2">{t('admin.activity_health.col_reason', 'Why Meeting?')}</th>
                <th className="px-3 py-2 text-right">{t('admin.activity_health.col_actions', 'Review')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 align-top last:border-b-0 dark:border-gray-900">
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.userName}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{r.userEmail}</div>
                    <div className="text-[10px] text-gray-400">{r.teamName}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                    {new Date(r.submittedAt ?? r.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <a href={`/activities?open=${r.id}`} className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">{r.title}</a>
                    <div className="text-[10px] text-gray-400">{new Date(r.startDatetime).toLocaleString()}</div>
                  </td>
                  <td className="max-w-md px-3 py-2 text-sm text-gray-700 dark:text-gray-300">{r.meetingTypeReason}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {(['ignore', 'will_watch', 'addressed'] as const).map((key) => {
                        const { Icon, activeClass } = STATUS_META[key]
                        const active = r.status === key
                        const label = t(`admin.activity_health.action_${key}`)
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={busyId === r.id}
                            onClick={() => setStatus(r.id, key)}
                            title={label}
                            aria-label={label}
                            aria-pressed={active}
                            className={cn(
                              'rounded-md p-1.5 transition-colors disabled:opacity-50',
                              active
                                ? activeClass
                                : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300',
                            )}
                          >
                            <Icon className="h-4 w-4" />
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-gray-400">
                      {r.status === null && (
                        <span className="inline-flex items-center gap-1"><Circle className="h-2.5 w-2.5" />{t('admin.activity_health.status_new', 'New')}</span>
                      )}
                      {r.status !== null && r.reviewedByName && r.reviewedAt && (
                        <span>{t('admin.activity_health.reviewed_by', 'Reviewed by {{name}} on {{date}}', { name: r.reviewedByName, date: new Date(r.reviewedAt).toLocaleDateString() })}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-sm text-gray-400">{t('admin.activity_health.no_matches', 'No matches.')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
