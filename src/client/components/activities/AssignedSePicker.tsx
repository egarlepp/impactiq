import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, UserCog, Info } from 'lucide-react'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.416.0: the Assigned Oppty SE picker, moved unchanged out of ActivityForm.tsx.

export interface SfUser { id: string; name: string; email: string | null; matched: boolean | null }

export interface AssignedSePickerProps {
  opportunityId: string
  teamId: string
  // '/api/salesforce' or '/api/crm' (HubSpot), from crmApiBaseFor().
  apiBase: string
  // Why the picker is disabled, when it's not the 90-day lock.
  lockedHint?: string | null
  value: { userId: string | null; userName: string | null; matched: boolean | null }
  onChange: (next: { userId: string | null; userName: string | null; matched: boolean | null }) => void
  initialValue: { userId: string | null; userName: string | null; matched: boolean | null }
  disabled?: boolean
}

// Searches crm_users (local cache) and lets the user reassign the Opportunity
// SE. Free-text search — narrows the dropdown as they type. Persists on
// activity save via a PATCH to /api/salesforce/opportunities/:id/assigned-se.
export function AssignedSePicker({ opportunityId: _oppId, teamId, apiBase, value, onChange, initialValue, disabled, lockedHint }: AssignedSePickerProps) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [q, setQ] = useState('')
  const [users, setUsers] = useState<SfUser[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  // v1.297.0: the resolved write field can be a plain Text field once an
  // admin maps assigned_se_write to one — there are no picklistValues to
  // offer in that case, so the picker falls back to committing whatever the
  // user typed instead of only offering a fixed list.
  const [fieldIsPicklist, setFieldIsPicklist] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    // The resolved write field is usually a Picklist in Salesforce — we
    // fetch the raw picklist values and use them as both id and display
    // name so the write stores exactly what SF accepts. Client-side filter
    // by q once we have the full list.
    void api.get<Array<{ value: string; label: string; matched: boolean }>>(`${apiBase}/picklists/opportunity/assigned-se?teamId=${encodeURIComponent(teamId)}`).then((res) => {
      if (cancelled) return
      const rows = (res.data ?? [])
        .filter((v) => !q.trim() || v.label.toLowerCase().includes(q.toLowerCase()))
        .map((v) => ({ id: v.value, name: v.label, email: null as string | null, matched: v.matched }))
      setUsers(rows)
      setFieldIsPicklist((res.meta['fieldType'] as string | null) !== 'string')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, q, teamId, apiBase])

  const changed = value.userId !== initialValue.userId

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      <div className="flex items-center gap-2">
        <Label className="inline-flex items-center gap-1.5">
          <UserCog className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
          {t('activity.form.assigned_se_label', 'Assigned Oppty SE')}
        </Label>
        {changed && (
          <Badge variant="warning" className="text-[9px]">
            {t('activity.form.assigned_se_will_update', { context: crmCtx, defaultValue: 'Will update Opportunity on save' })}
          </Badge>
        )}
      </div>
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded border border-gray-200 bg-white px-2 py-1.5 text-left text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 disabled:opacity-60"
        >
          <span
            className={value.userName && value.matched === false ? 'truncate text-red-600 dark:text-red-400' : 'truncate'}
            title={value.userName && value.matched === false ? t('activity.form.assigned_se_not_in_impactiq', 'Not an ImpactIQ user') : undefined}
          >
            {value.userName ?? <span className="text-gray-400">{t('activity.form.assigned_se_none', 'Unassigned')}</span>}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        </button>
        {lockedHint && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
            <Info className="h-3 w-3 shrink-0" />
            {lockedHint}
          </p>
        )}
        {open && !disabled && (
          <div className="absolute z-50 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-100 p-2 dark:border-gray-800">
              <Input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('activity.form.assigned_se_search_placeholder', { context: crmCtx, defaultValue: 'Search SF users…' })}
                className="h-8 text-xs"
              />
            </div>
            <div className="max-h-48 overflow-y-auto py-1 text-sm">
              <button
                type="button"
                onClick={() => { onChange({ userId: null, userName: null, matched: null }); setOpen(false) }}
                className="flex w-full px-3 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                {t('activity.form.assigned_se_unassign', 'Unassign')}
              </button>
              {loading && <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>}
              {/* v1.297.0: the resolved write field can be a plain Text field
                  (an admin-mapped assigned_se_write with no picklist), which
                  has no fixed values to list — offer to write exactly what
                  was typed instead of showing an empty, dead-end dropdown. */}
              {!loading && !fieldIsPicklist && q.trim() && (
                <button
                  type="button"
                  onClick={() => { onChange({ userId: q.trim(), userName: q.trim(), matched: null }); setOpen(false) }}
                  className="flex w-full px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-gray-100 dark:text-blue-400 dark:hover:bg-gray-800"
                >
                  {t('activity.form.assigned_se_use_custom', 'Use "{{value}}"', { value: q.trim() })}
                </button>
              )}
              {!loading && users.length === 0 && (
                <p className="px-3 py-2 text-xs text-gray-400">{t('sf.no_results')}</p>
              )}
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { onChange({ userId: u.id, userName: u.name, matched: u.matched }); setOpen(false) }}
                  className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <span
                    className={u.matched === false ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}
                    title={u.matched === false ? t('activity.form.assigned_se_not_in_impactiq', 'Not an ImpactIQ user') : undefined}
                  >
                    {u.name}
                  </span>
                  {u.email && <span className="text-[10px] text-gray-500 dark:text-gray-400">{u.email}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
