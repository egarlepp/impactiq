import { useState, useEffect, useMemo, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { useCrmLabelContext } from '../store/crmProvider.js'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import {
  History,
  ListChecks,
  Clock,
  Building2,
  CalendarRange,
  Repeat,
  Sun,
  SearchX,
  Link2Off,
  Inbox,
} from 'lucide-react'
import { PageHeader } from '../components/ui/page-header.js'
import { Spinner } from '../components/ui/spinner.js'
import { SingleSelect } from '../components/ui/single-select.js'
import { SortableTh, TablePagination } from '../components/ui/table-controls.js'
import { useTableView } from '../lib/tableView.js'
import { EstimatedHours, HistoricalEstimateBanner, RecurringBadge, AllDayBadge } from '../components/ui/historical.js'
import { api } from '../lib/api.js'
import { cn } from '../lib/utils.js'

// v1.214.0: a contributor's own pre-ImpactIQ Salesforce activity.
//
// Read-only reference, deliberately kept off the Weekly View. That page is
// the write surface — log, edit, submit, the 90-day edit rule — and a 2023 SF
// Event sitting next to a draggable draft would be a category error. The only
// link between them points this way.

interface HistRow {
  crmEventId: string
  subject: string | null
  crmType: string | null
  activityDate: string | null
  estimatedHours: string | null
  whatName: string | null
  whatType: string | null
  accountId: string | null
  activityTypeName: string | null
  isRecurrence: boolean
  isAllDayEvent: boolean
}

interface HistMeta {
  count: number
  estimatedHours: number
  rowsMissingDuration: number
  earliest: string | null
  latest: string | null
  linked: boolean
  distinctAccounts: number
  years: number[]
  byType: Array<{ crmType: string; count: number; estimatedHours: number }>
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/25">
      <Icon className="pointer-events-none absolute -right-2 -top-2 h-16 w-16 text-amber-200/50 dark:text-amber-900/30" />
      <div className="relative">
        <div className="mb-1 inline-flex rounded-md bg-amber-100 p-1.5 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <p className="text-[11px] uppercase tracking-wide text-amber-800/80 dark:text-amber-300/80">{label}</p>
        <p className="text-xl font-semibold text-amber-900 dark:text-amber-100">{value}</p>
        {sub && <p className="text-[11px] text-amber-700/70 dark:text-amber-400/70">{sub}</p>}
      </div>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-gray-300 py-10 text-center dark:border-gray-700">
      <Icon className="h-8 w-8 text-gray-400 dark:text-gray-600" />
      <p className="font-medium text-gray-700 dark:text-gray-200">{title}</p>
      <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">{body}</p>
      {action}
    </div>
  )
}

export default function MyHistory() {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [rows, setRows] = useState<HistRow[]>([])
  const [meta, setMeta] = useState<HistMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [year, setYear] = useState('all')
  const [crmType, setSfType] = useState('all')
  const [recurring, setRecurring] = useState('all')
  const [allDay, setAllDay] = useState('all')

  // One fetch for the whole history — per-user row counts are small, so
  // useTableView can own search/sort/paging with no server round-trips.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api
      .get<HistRow[]>(`/api/history/me?limit=2000&recurring=${recurring}&allDay=${allDay}`)
      .then((res) => {
        if (cancelled) return
        setRows(res.data ?? [])
        setMeta((res.meta as unknown as HistMeta) ?? null)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [recurring, allDay])

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (year !== 'all' && (r.activityDate ?? '').slice(0, 4) !== year) return false
      if (crmType !== 'all' && (r.activityTypeName ?? r.crmType ?? '') !== crmType) return false
      return true
    })
  }, [rows, year, crmType])

  const view = useTableView<HistRow>(
    filtered,
    {
      date: (r) => r.activityDate ?? '',
      subject: (r) => r.subject ?? '',
      type: (r) => r.activityTypeName ?? r.crmType ?? '',
      related: (r) => r.whatName ?? '',
      hours: (r) => (r.estimatedHours ?? ''),
    },
    { pageSize: 25, resetKey: `${year}|${crmType}|${recurring}|${allDay}` },
  )

  const typeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const v = r.activityTypeName ?? r.crmType
      if (v) set.add(v)
    }
    return [
      { value: 'all', label: t('history.filter_type_all') },
      ...Array.from(set)
        .sort()
        .map((v) => ({ value: v, label: v })),
    ]
  }, [rows, t])

  const yearOptions = useMemo(
    () => [
      { value: 'all', label: t('history.filter_year_all') },
      ...(meta?.years ?? []).map((y) => ({ value: String(y), label: String(y) })),
    ],
    [meta, t],
  )

  const rangeLabel =
    meta?.earliest && meta?.latest
      ? `${meta.earliest.slice(0, 7)} → ${meta.latest.slice(0, 7)}`
      : '—'

  return (
    // Match Settings / Dashboard / My Notes / Guide: outer has NO padding so
    // the PageHeader sits flush with the top nav edge; the inner content div
    // owns its own p-6 (24px) so this page respects the same left/right
    // breathing room from the sidebar and browser edge as every other page.
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader icon={History} title={t('history.my.title')} subtitle={t('history.my.subtitle', { context: crmCtx })} />

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      <HistoricalEstimateBanner variant="full" />

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {/* On HubSpot the match is by email, so there's nothing in My Settings to
          link; the admin syncs owners instead (v1.401.0). */}
      {/* Three distinct empty states. Collapsing them into one generic "no
          data" guarantees a bug report when the real cause is an unset
          Salesforce user id. */}
      {!loading && meta && !meta.linked && (
        <EmptyState
          icon={Link2Off}
          title={t('history.my.empty_unlinked_title', { context: crmCtx })}
          body={t('history.my.empty_unlinked_body', { context: crmCtx })}
          action={crmCtx === 'hubspot' ? undefined : (
            <Link
              to="/settings"
              className="mt-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('history.my.empty_unlinked_cta')}
            </Link>
          )}
        />
      )}

      {/* Only claim "nothing was imported" when no server-side flag filter is
          narrowing the result — otherwise a filter that matches nothing would
          masquerade as an empty import. */}
      {!loading && meta?.linked && rows.length === 0 && recurring === 'all' && allDay === 'all' && (
        <EmptyState
          icon={Inbox}
          title={t('history.my.empty_none_title')}
          body={t('history.my.empty_none_body', { context: crmCtx })}
        />
      )}

      {!loading && meta?.linked && rows.length === 0 && (recurring !== 'all' || allDay !== 'all') && (
        <EmptyState
          icon={SearchX}
          title={t('history.my.empty_filtered')}
          body={t('history.my.empty_filtered_body')}
          action={
            <button
              type="button"
              onClick={() => { setRecurring('all'); setAllDay('all') }}
              className="mt-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('history.my.clear_filters')}
            </button>
          }
        />
      )}

      {!loading && rows.length > 0 && meta && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              icon={ListChecks}
              label={t('history.my.kpi_activities')}
              value={String(meta.count)}
            />
            <StatTile
              icon={Clock}
              label={t('history.my.kpi_est_hours')}
              value={`~${meta.estimatedHours.toFixed(0)}h`}
              sub={t('history.est_from_sf', { context: crmCtx })}
            />
            <StatTile
              icon={Building2}
              label={t('history.my.kpi_accounts', { context: crmCtx })}
              value={String(meta.distinctAccounts)}
            />
            <StatTile icon={CalendarRange} label={t('history.my.kpi_range')} value={rangeLabel} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SingleSelect
              label={t('history.filter_year')}
              labelIcon={CalendarRange}
              options={yearOptions}
              value={year}
              onChange={setYear}
            />
            <SingleSelect
              label={t('history.filter_type')}
              options={typeOptions}
              value={crmType}
              onChange={setSfType}
            />
            <SingleSelect
              label={t('history.filter_recurring')}
              labelIcon={Repeat}
              options={[
                { value: 'all', label: t('history.filter_recurring_all') },
                { value: 'only', label: t('history.filter_recurring_only') },
                { value: 'exclude', label: t('history.filter_recurring_exclude') },
              ]}
              value={recurring}
              onChange={setRecurring}
            />
            <SingleSelect
              label={t('history.filter_all_day')}
              labelIcon={Sun}
              options={[
                { value: 'all', label: t('history.filter_all_day_all') },
                { value: 'only', label: t('history.filter_all_day_only') },
                { value: 'exclude', label: t('history.filter_all_day_exclude') },
              ]}
              value={allDay}
              onChange={setAllDay}
            />
            <Link
              to="/"
              className="ml-auto text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('history.my.link_to_activities')}
            </Link>
          </div>

          {view.total === 0 ? (
            <EmptyState
              icon={SearchX}
              title={t('history.my.empty_filtered')}
              body={t('history.my.empty_filtered_body')}
              action={
                <button
                  type="button"
                  onClick={() => {
                    setYear('all')
                    setSfType('all')
                  }}
                  className="mt-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  {t('history.my.clear_filters')}
                </button>
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <tr>
                    <SortableTh label={t('history.col.date')} colKey="date" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
                    <SortableTh label={t('history.col.subject')} colKey="subject" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters['subject'] ?? ''} onFilter={(v) => view.setFilter('subject', v)} />
                    <SortableTh label={t('history.col.type')} colKey="type" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters['type'] ?? ''} onFilter={(v) => view.setFilter('type', v)} />
                    <SortableTh label={t('history.col.related_to')} colKey="related" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters['related'] ?? ''} onFilter={(v) => view.setFilter('related', v)} />
                    <SortableTh label={t('history.col.est_hours')} colKey="hours" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {view.visible.map((r) => (
                    <tr
                      key={r.crmEventId}
                      className={cn('border-b border-gray-100 last:border-0 dark:border-gray-800')}
                    >
                      <td className="whitespace-nowrap px-3 py-2 text-gray-600 dark:text-gray-300">
                        {r.activityDate ? format(new Date(`${r.activityDate}T00:00:00`), 'd MMM yyyy') : '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-800 dark:text-gray-100">
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          {r.subject || '—'}
                          {r.isRecurrence && <RecurringBadge />}
                          {r.isAllDayEvent && <AllDayBadge />}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-600 dark:text-gray-300">
                        {r.activityTypeName ?? r.crmType ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                        {r.whatName ?? '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <EstimatedHours hours={r.estimatedHours} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
            </div>
          )}
        </>
      )}
      </div>
    </div>
  )
}
