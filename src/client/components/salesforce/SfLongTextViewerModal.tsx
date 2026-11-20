import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

// Centered-overlay "view full text" modal — same chrome as SfActivitiesModal
// (fixed inset-0 z-50, role="dialog"), reused here for showing a Salesforce
// long-text field's complete current value. Read-only; editing happens via
// SfFieldPrependPanel, never here.
export function SfLongTextViewerModal({
  title,
  text,
  onClose,
}: {
  title: string
  text: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        role="dialog"
        aria-modal
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {text ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-xs text-gray-700 dark:text-gray-300">{text}</pre>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500">{t('salesforce.field_prepend.empty_field')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
