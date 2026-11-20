import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Users } from 'lucide-react'
import { api } from '../../lib/api.js'
import { crmApiBaseFor, useCrmLabelContext, useCrmProvider } from '../../store/crmProvider.js'
import type { SfSelection } from '../salesforce/SfSearch.js'

interface Account { Id: string; Name: string; OwnerName: string | null; contactName: string; contactEmail: string }
// v1.104.0: pull through Amount / CloseDate / ForecastCategoryName so the
// picked Opportunity seeds ACV + the summary row identically to the
// SfSearch popover flow. The endpoint has been returning these since
// v1.101; this component just wasn't declaring them. v1.181.0: also declare
// OwnerName so the row can show Owner (already returned by the endpoint).
interface Opportunity { Id: string; Name: string; AccountName: string; StageName: string; Amount: number | null; CloseDate: string | null; ForecastCategoryName: string | null; OwnerName: string | null; contactName: string; contactEmail: string }
interface SuggestionsPayload { accounts: Account[]; opportunities: Opportunity[] }

interface Props {
  attendees: { name?: string; email?: string }[]
  disabled?: boolean
  onPick: (sel: SfSelection) => void
}

// Collapsed by default. Fetches SF Contact-based suggestions from the
// external attendees on the meeting; hidden when there are no attendees or
// no matches. Clicking a row hoists the selection to the parent form.
export function AttendeeSuggestions({ attendees, disabled, onPick }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<SuggestionsPayload | null>(null)
  const [sfNotConnected, setSfNotConnected] = useState(false)

  // Contacts matched by email on whichever CRM the install uses.
  const crmProvider = useCrmProvider()
  const crmCtx = useCrmLabelContext()
  const emails = attendees.map((a) => a.email).filter((e): e is string => !!e && e.includes('@'))
  const key = emails.slice().sort().join(',')

  useEffect(() => {
    if (emails.length === 0 || crmProvider === 'none') { setData(null); setSfNotConnected(false); return }
    setLoading(true)
    setSfNotConnected(false)
    void api.post<SuggestionsPayload>(`${crmApiBaseFor(crmProvider)}/suggestions/by-attendees`, { emails })
      .then((res) => {
        if (res.error && res.error.includes('not_connected')) {
          setSfNotConnected(true)
          setData(null)
        } else {
          setData(res.data ?? { accounts: [], opportunities: [] })
        }
      })
      .finally(() => setLoading(false))
  }, [key, crmProvider])

  const total = (data?.accounts.length ?? 0) + (data?.opportunities.length ?? 0)
  if (emails.length === 0) return null
  if (sfNotConnected) {
    return (
      <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
        {t('activity.attendee_suggestions.sf_not_connected', { context: crmCtx })}
      </p>
    )
  }
  if (!loading && total === 0) return null

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          {t('activity.attendee_suggestions.title', { count: total })}
        </span>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <div className="border-t border-gray-100 dark:border-gray-900 px-3 py-2 text-sm">
          {loading && <p className="text-xs text-gray-500 dark:text-gray-400">…</p>}
          {!loading && data && data.opportunities.length > 0 && (
            <div className="mb-2">
              <p className="mb-1 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">{t('activity.attendee_suggestions.opportunities', { context: crmCtx })}</p>
              <ul className="flex flex-col gap-1">
                {data.opportunities.map((o) => (
                  <li key={o.Id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onPick({ id: o.Id, name: o.Name, type: 'Opportunity', extra: { amount: o.Amount ?? null, closeDate: o.CloseDate ?? null, stageName: o.StageName, forecastCategoryName: o.ForecastCategoryName ?? null, ownerName: o.OwnerName ?? null, accountName: o.AccountName } })}
                      className="w-full rounded px-2 py-1 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                    >
                      <div className="font-medium text-gray-900 dark:text-gray-100">{o.Name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {[o.AccountName, o.StageName, o.OwnerName ? t('sf.owner_short', 'Owner: {{name}}', { name: o.OwnerName }) : null, o.CloseDate ? t('sf.close_date_short_full', 'Closes {{date}}', { date: o.CloseDate }) : null].filter(Boolean).join(' · ')}
                      </div>
                      <div className="text-[11px] text-gray-400 dark:text-gray-500">
                        {t('activity.attendee_suggestions.via', { name: o.contactName, email: o.contactEmail })}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!loading && data && data.accounts.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">{t('activity.attendee_suggestions.accounts', { context: crmCtx })}</p>
              <ul className="flex flex-col gap-1">
                {data.accounts.map((a) => (
                  <li key={a.Id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onPick({ id: a.Id, name: a.Name, type: 'Account' })}
                      className="w-full rounded px-2 py-1 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                    >
                      <div className="font-medium text-gray-900 dark:text-gray-100">{a.Name}</div>
                      {a.OwnerName && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">{t('sf.owner_short', 'Owner: {{name}}', { name: a.OwnerName })}</div>
                      )}
                      <div className="text-[11px] text-gray-400 dark:text-gray-500">
                        {t('activity.attendee_suggestions.via', { name: a.contactName, email: a.contactEmail })}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
