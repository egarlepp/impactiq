import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'

// v1.126.0: shared empty state for every dashboard tab. Explains WHY
// the tab is empty (not just "no data") so users don't assume the
// dashboard is broken. Reason keys drive slightly different copy:
//
//   - 'no_data'          → default; "no submitted activities in the
//                          selected range". Also nudges the user to
//                          widen the range or check Draft filter.
//   - 'no_accessible_teams' → the caller isn't a member of any team;
//                             they need admin to add them.
//   - 'no_products'      → filter combo excludes everything.
//   - <custom>           → free-form message the dashboard can pass.
export function DashboardEmptyState({
  reason = 'no_data',
  message,
}: {
  reason?: 'no_data' | 'no_accessible_teams' | 'no_products' | 'select_team' | 'custom'
  message?: string
}) {
  const { t } = useTranslation()
  const title = message
    ?? (reason === 'no_accessible_teams'
      ? t('leader.empty_state.no_accessible_teams.title', 'You are not on any team yet')
      : reason === 'no_products'
        ? t('leader.empty_state.no_products.title', 'No activities match the product filter')
        : reason === 'select_team'
          ? t('leader.empty_state.select_team.title', 'Select a specific team')
          : t('leader.empty_state.no_data.title', 'No submitted activities in this range'))
  const hint = reason === 'no_accessible_teams'
    ? t('leader.empty_state.no_accessible_teams.hint', 'Ask your app admin to add you to a team on Admin → User Management, or a subteam under one.')
    : reason === 'no_products'
      ? t('leader.empty_state.no_products.hint', 'Clear the Products filter or pick a different combination.')
      : reason === 'select_team'
        ? t('leader.empty_state.select_team.hint', 'This report doesn\'t support All Teams — pick one from the team switcher above.')
        : t('leader.empty_state.no_data.hint', 'Draft or unapproved Outlook meetings don\'t count — only Submitted activities are aggregated. Try widening the range or the "All" chip.')
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <Inbox className="h-8 w-8 text-gray-300 dark:text-gray-600" />
      <p className="text-sm font-medium text-gray-600 dark:text-gray-300">{title}</p>
      <p className="max-w-md text-xs text-gray-500 dark:text-gray-400">{hint}</p>
    </div>
  )
}
