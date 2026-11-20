import { useTranslation } from 'react-i18next'
import { CalendarClock, CheckCircle2, CircleSlash } from 'lucide-react'
import { InfoPopover } from '../ui/info-popover.js'

// v1.226.0: always-visible "About Meeting Load" explainer, shared by
// ThisWeekCapacity, TeamHeatmap, and CapacityTrend. Deliberately NOT gated on
// `enabled` — the whole point is that a leader whose team hasn't opted in
// can still discover the feature exists and learn what to do about it,
// instead of the figure just silently never appearing. See CLAUDE.md §12.1.
export function MeetingLoadInfo({ enabled }: { enabled?: boolean }) {
  const { t } = useTranslation()

  return (
    <InfoPopover ariaLabel={t('leader.meeting_load.help.title')}>
      <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <CalendarClock className="h-4 w-4 shrink-0 text-gray-400" />
        {t('leader.meeting_load.help.title')}
      </p>
      <p className="mb-2 text-gray-600 dark:text-gray-400">{t('leader.this_week.meeting_load_hint')}</p>

      <p className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
        {t('leader.meeting_load.help.requires_heading')}
      </p>
      <p className="mb-3 text-gray-600 dark:text-gray-400">{t('leader.meeting_load.help.requires_body')}</p>

      <p className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
        {t('leader.meeting_load.help.caveat_heading')}
      </p>
      <p className="mb-3 text-gray-600 dark:text-gray-400">{t('leader.meeting_load.help.caveat_body')}</p>

      <p className={`flex items-center gap-1.5 ${enabled ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
        {enabled
          ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          : <CircleSlash className="h-3.5 w-3.5 shrink-0" />}
        {t(enabled ? 'leader.meeting_load.help.enabled_status' : 'leader.meeting_load.help.disabled_status')}
      </p>
    </InfoPopover>
  )
}
