import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { Button } from './button.js'
import type { SortDir } from '../../lib/tableView.js'

// Small sortable header cell with an optional inline column search input.
// Used by admin data tables (LoginHistory, AuditLog).
export function SortableTh({
  label,
  colKey,
  sortKey,
  sortDir,
  onToggle,
  filterValue,
  onFilter,
  filterPlaceholder,
  className = '',
  align = 'left',
  disableSort = false,
}: {
  label: ReactNode
  colKey: string
  sortKey: string | null
  sortDir: SortDir
  onToggle: (col: string) => void
  filterValue?: string
  onFilter?: (val: string) => void
  filterPlaceholder?: string
  className?: string
  // Horizontal alignment of the header row itself. `center` and `right`
  // let numeric columns line up their label directly over the (centered
  // or right-aligned) numeric cells — text-center on the th alone
  // doesn't propagate through the inner flex containers.
  align?: 'left' | 'center' | 'right'
  disableSort?: boolean
}) {
  const justifyClass = align === 'center' ? 'justify-center' : align === 'right' ? 'justify-end' : 'justify-between'
  const { t } = useTranslation()
  const isActive = sortKey === colKey && sortDir !== null
  const arrow = isActive ? (sortDir === 'asc' ? '↑' : '↓') : ''
  const hasFilter = Boolean(filterValue && filterValue.length > 0)
  const [searchOpen, setSearchOpen] = useState(hasFilter)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])
  // Keep the row open while there's a live filter, even after blur.
  useEffect(() => { if (hasFilter && !searchOpen) setSearchOpen(true) }, [hasFilter, searchOpen])
  return (
    <th className={`px-3 py-2 align-top ${className}`}>
      <div className="flex flex-col gap-1">
        <div className={`flex items-center gap-2 ${justifyClass}`}>
          {disableSort ? (
            <span className="inline-flex items-center gap-1">{label}</span>
          ) : (
            <button
              type="button"
              onClick={() => onToggle(colKey)}
              className="inline-flex items-center gap-1 text-left hover:text-gray-700 dark:hover:text-gray-200"
            >
              <span>{label}</span>
              {isActive && <span aria-hidden>{arrow}</span>}
            </button>
          )}
          {onFilter && (
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              className={`shrink-0 rounded p-0.5 transition-colors ${hasFilter || searchOpen ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'}`}
              title={t('common.search_column', 'Search column')}
              aria-label={t('common.search_column', 'Search column')}
            >
              <Search className="h-3 w-3" />
            </button>
          )}
        </div>
        {onFilter && searchOpen && (
          <div className="relative">
            <input
              ref={inputRef}
              value={filterValue ?? ''}
              onChange={(e) => onFilter(e.target.value)}
              placeholder={filterPlaceholder}
              className="w-full rounded border border-gray-200 bg-white px-1.5 py-0.5 pr-5 text-[11px] font-normal normal-case tracking-normal text-gray-700 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200"
            />
            {(hasFilter || searchOpen) && (
              <button
                type="button"
                onClick={() => { onFilter(''); setSearchOpen(false) }}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                title={t('common.clear', 'Clear')}
                aria-label={t('common.clear', 'Clear')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </th>
  )
}

export function TablePagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  const { t } = useTranslation()
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-end gap-2 px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
      <span>{t('common.pagination.page', { page, total: totalPages })}</span>
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        {t('common.pagination.prev')}
      </Button>
      <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        {t('common.pagination.next')}
      </Button>
    </div>
  )
}
