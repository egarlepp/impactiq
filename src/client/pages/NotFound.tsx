import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CalendarDays, FileQuestion } from 'lucide-react'
import { PageHeader } from '../components/ui/page-header.js'

// v1.420.0: catch-all route inside PageShell, so a mistyped or outdated link
// shows a message with a way back instead of an empty page.
export default function NotFound() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader icon={FileQuestion} title={t('not_found.title')} />
      <div className="flex flex-1 items-start justify-center overflow-y-auto p-6 md:p-10">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2">
            <FileQuestion className="h-6 w-6 shrink-0 text-red-600 dark:text-red-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('not_found.heading')}</h2>
          </div>
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">{t('not_found.description')}</p>
          <Link
            to="/"
            className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary-light,#2563eb)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg-light,#ffffff)] hover:opacity-90 dark:bg-[var(--color-primary-dark,#3b82f6)] dark:text-[var(--color-primary-fg-dark,#ffffff)]"
          >
            <CalendarDays className="h-4 w-4" />
            {t('not_found.back')}
          </Link>
        </div>
      </div>
    </div>
  )
}
