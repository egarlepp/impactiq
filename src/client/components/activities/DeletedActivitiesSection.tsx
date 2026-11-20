import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { ChevronDown, ChevronRight, MailX, SavePen, Trash2, CheckCircle2 } from 'lucide-react'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { formatTimeInTZ } from '../../lib/tz.js'
import { formatRelativeTime } from '../../lib/time.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import type { Activity } from '../../hooks/useActivities.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.242.0: review queue for APPROVED activities whose Outlook meeting has been
// deleted from the calendar.
//
// Sits above the first day of the week rather than inside its day, because the
// activity's own date is no longer the useful axis — the point is "these need a
// decision", and leaving them in place is exactly how they'd get missed.
//
// Exempt from every list filter (Show Non-Activities, the Required/Optional
// attendee filter, the activity-type filter) by design: an exception queue that
// a filter can hide is an exception queue that silently loses items.
export function DeletedActivitiesSection({
  items,
  weekStartIso,
  busy,
  onKeep,
  onPurge,
}: {
  items: Activity[]
  weekStartIso: string
  busy: boolean
  onKeep: (opts: { ids?: string[]; weekStart?: string }) => void
  onPurge: (opts: { ids?: string[]; weekStart?: string }) => void
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const { user } = useCurrentUser()
  const tz = user?.timezone ?? null
  const [collapsed, setCollapsed] = useState(false)

  if (items.length === 0) return null

  function confirmPurge(count: number, onYes: () => void) {
    // Hard delete + Salesforce delete, with no undo anywhere. The confirm text
    // says so explicitly rather than asking a generic "are you sure?".
    const msg = t('activity.outlook_deleted.confirm_delete', { count, context: crmCtx })
    if (window.confirm(msg)) onYes()
  }
  function confirmKeep(count: number, onYes: () => void) {
    const msg = t('activity.outlook_deleted.confirm_keep', { count, context: crmCtx })
    if (window.confirm(msg)) onYes()
  }

  return (
    <div className="rounded-lg border border-orange-300 bg-orange-50/60 dark:border-orange-800 dark:bg-orange-950/20">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left text-sm font-semibold text-orange-900 dark:text-orange-200"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
          <MailX className="h-4 w-4 shrink-0" />
          <span>
            {t('activity.outlook_deleted.section_title')} — {items.length}
          </span>
        </button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => confirmKeep(items.length, () => onKeep({ weekStart: weekStartIso }))}
          title={t('activity.outlook_deleted.keep_all_hint')}
        >
          {busy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <SavePen className="mr-1 h-3.5 w-3.5" />}
          {t('activity.outlook_deleted.keep_all')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => confirmPurge(items.length, () => onPurge({ weekStart: weekStartIso }))}
          title={t('activity.outlook_deleted.delete_all_hint', { context: crmCtx })}
          className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          {busy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
          {t('activity.outlook_deleted.delete_all')}
        </Button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <p className="text-[11px] text-orange-800 dark:text-orange-300">
            {t('activity.outlook_deleted.section_help', { context: crmCtx })}
          </p>
          {items.map((a) => (
            <div
              key={a.id}
              className="flex flex-col gap-1 rounded-md border border-orange-200 bg-white p-3 dark:border-orange-900 dark:bg-gray-900"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="flex flex-1 items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                  {a.activityTypeIcon && (
                    <DynamicIcon
                      name={a.activityTypeIcon}
                      className="h-4 w-4 shrink-0"
                      {...(a.activityTypeColor ? { style: { color: a.activityTypeColor } } : {})}
                    />
                  )}
                  <span className="line-clamp-2">{a.title}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => confirmKeep(1, () => onKeep({ ids: [a.id] }))}
                    disabled={busy}
                    title={t('activity.outlook_deleted.keep_hint')}
                    aria-label={t('activity.outlook_deleted.keep_hint')}
                    className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                  >
                    <SavePen className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => confirmPurge(1, () => onPurge({ ids: [a.id] }))}
                    disabled={busy}
                    title={t('activity.outlook_deleted.delete_hint')}
                    aria-label={t('activity.outlook_deleted.delete_hint')}
                    className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="secondary"
                  style={a.activityTypeColor ? { backgroundColor: a.activityTypeColor, color: '#fff', borderColor: a.activityTypeColor } : undefined}
                >
                  {a.activityTypeName}
                </Badge>
                {a.crmWhatName && (
                  <span className="truncate text-xs text-gray-600 dark:text-gray-300">{a.crmWhatName}</span>
                )}
              </div>

              <div className="text-xs text-gray-500 dark:text-gray-400">
                {formatTimeInTZ(a.startDatetime, tz)} · {Number(a.effortHours).toFixed(1)}h
              </div>

              {/* Created date → Not In Outlook → Synced, matching the row
                  order on a normal approved card. */}
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                <span title={new Date(a.createdAt).toLocaleString()}>
                  {t('activity.date_created')}: {format(new Date(a.createdAt), 'MMM d, yyyy')}
                </span>
                <Badge
                  variant="outline"
                  className="gap-1 border-orange-400 text-orange-700 dark:border-orange-600 dark:text-orange-400"
                  title={t('activity.outlook_deleted.badge_hint')}
                >
                  <MailX className="h-3 w-3" />
                  {t('activity.outlook_deleted.badge')}
                </Badge>
                {a.crmSyncStatus === 'synced' && (
                  <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-3 w-3" />
                    {a.crmSyncedAt
                      ? t('activity.sync.synced_ago', { when: formatRelativeTime(a.crmSyncedAt, t) })
                      : t('activity.sync.synced', { context: crmCtx })}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
