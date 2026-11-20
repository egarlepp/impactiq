import { useTranslation } from 'react-i18next'
import { CsvImportSection } from '../settings/CsvImportSection.js'

// Admin bulk CSV import wrapper. Uses the same CsvImportSection but points at
// the /api/admin endpoint so team_admin and app_admin can import rows on
// behalf of any team member.
export function ActivitiesImport() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
        {t('admin.activities_import.header_hint')}
      </div>
      <CsvImportSection adminMode />
    </div>
  )
}
