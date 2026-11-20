import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { Calendar, MapPin, Users, Info, ClipboardEdit, CalendarOff, Lock } from 'lucide-react'
import { Dialog } from '../ui/dialog.js'
import { Button } from '../ui/button.js'
import { Badge } from '../ui/badge.js'
import { AttendeeResponseBadge } from './AttendeeResponseBadge.js'
import type { CalendarEvent } from '../../hooks/useCalendar.js'

interface Props {
  open: boolean
  event: CalendarEvent | null
  onClose: () => void
  onLogActivity: (event: CalendarEvent) => void
  isNonActivity?: boolean
  onMarkAsActivity?: (event: CalendarEvent) => void
}

export function EventDetailsModal({ open, event, onClose, onLogActivity, isNonActivity, onMarkAsActivity }: Props) {
  const { t } = useTranslation()
  if (!event) return null
  const start = new Date(event.start)
  const end = new Date(event.end)
  const isPrivate = !!event.isPrivate

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isPrivate ? t('activity.private_meeting.title', 'Private meeting') : event.subject}
      titleIcon={isPrivate ? Lock : Calendar}
    >
      <div className="flex flex-col gap-4">
        {isPrivate && (
          <Badge variant="outline" className="w-fit gap-1" title={t('activity.private_meeting.pill_hint', "This meeting is marked Private/Confidential in Outlook — it's shown here as Private meeting.")}>
            <Lock className="h-3 w-3" />
            {t('activity.private_meeting.pill', 'Private')}
          </Badge>
        )}
        {isNonActivity && (
          <div className="flex items-start gap-2 rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-sm text-gray-100">
            <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-200" />
            <div className="flex flex-1 flex-col gap-1">
              <span className="font-semibold">{t('activity.non_activity.form_banner_title')}</span>
              <span className="text-xs text-gray-200">{t('activity.non_activity.form_banner_body')}</span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Calendar className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span>{format(start, 'EEE, MMM d, yyyy')}</span>
          <span className="text-gray-400">·</span>
          <span>{format(start, 'h:mm a')} – {format(end, 'h:mm a')}</span>
        </div>

        {event.location && (
          <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <MapPin className="h-4 w-4 text-gray-500" />
            <span>{event.location}</span>
          </div>
        )}

        {event.organizer && event.organizer.email && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t('calendar.event_details.organizer')}
            </span>
            <span className="text-sm text-gray-800 dark:text-gray-200">
              {event.organizer.name || event.organizer.email}
              {event.organizer.name && event.organizer.name !== event.organizer.email && (
                <span className="text-gray-400 dark:text-gray-500"> · {event.organizer.email}</span>
              )}
            </span>
          </div>
        )}

        {event.attendees && event.attendees.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <Users className="h-3.5 w-3.5" />
              {t('calendar.event_details.attendees', { count: event.attendees.length })}
            </span>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-gray-200 bg-gray-50 p-2 text-xs dark:border-gray-700 dark:bg-gray-800/60">
              {event.attendees.map((a, i) => (
                <div key={`${a.email}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="text-gray-800 dark:text-gray-100">{a.name || a.email}</span>
                  <div className="flex items-center gap-1.5">
                    {a.type === 'optional' && <Badge variant="outline" className="text-[10px]">{t('calendar.event_details.optional')}</Badge>}
                    <AttendeeResponseBadge response={a.response} className="text-[10px]" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {event.bodyPreview && (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <Info className="h-3.5 w-3.5" />
              {t('calendar.event_details.description')}
            </span>
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300">
              {event.bodyPreview}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
          {!event.alreadyLogged && (
            isNonActivity && onMarkAsActivity ? (
              <Button size="sm" onClick={() => { onMarkAsActivity(event); onLogActivity(event); onClose() }}>
                <CalendarOff className="mr-1 h-3.5 w-3.5" />
                {t('activity.non_activity.unmark')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => { onLogActivity(event); onClose() }}>
                <ClipboardEdit className="mr-1 h-3.5 w-3.5" />
                {t('calendar.event_details.log_activity')}
              </Button>
            )
          )}
        </div>
      </div>
    </Dialog>
  )
}
