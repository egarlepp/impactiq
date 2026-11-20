import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'

// Rendered by dashboards whose chart shape is "N discrete week columns"
// (Team Heatmap, Team Capacity Trend, etc.). Those charts break when
// weeksBack=0 because there's no bounded column count. The picker still
// offers All so the range chip stays consistent app-wide, but these
// specific dashboards fall back to this notice so a leader isn't stuck
// looking at an empty grid and questioning the data.
export function AllTimeNotApplicable() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto my-6 flex max-w-md items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">{t('leader.all_time_not_applicable.title', "All-time isn't shown here")}</p>
        <p className="text-xs">
          {t('leader.all_time_not_applicable.body', "This chart plots one column per week. Rendering every week since day one would be unreadable. Pick 1w, 4w, 8w, 12w, or a custom range to see the data.")}
        </p>
      </div>
    </div>
  )
}
