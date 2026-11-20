import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Building2, TrendingUp, X, User, UserPlus, Megaphone } from 'lucide-react'
import { SfRelationshipHelp } from './SfRelationshipHelp.js'
import { Input } from '../ui/input.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { cn } from '../../lib/utils.js'
import { api } from '../../lib/api.js'
import { useCrmFeatures } from '../../store/crmFeatures.js'
import { crmApiBaseFor, useCrmLabelContext, useCrmProvider } from '../../store/crmProvider.js'

interface SfOpportunity {
  Id: string
  Name: string
  StageName: string
  AccountId: string | null
  AccountName: string
  CloseDate: string
  Amount: number | null
  ForecastCategoryName: string | null
  OwnerName: string | null
}

interface SfAccount {
  Id: string
  Name: string
  Industry: string | null
  OwnerName: string | null
}

interface SfContact {
  Id: string
  Name: string
  Email: string | null
  AccountName: string | null
  Title: string | null
}

interface SfLead {
  Id: string
  Name: string
  Email: string | null
  Company: string | null
  Status: string | null
}

export type SfSelectionType = 'Opportunity' | 'Account' | 'Contact' | 'Lead' | 'Campaign'

export interface SfSelection {
  id: string
  name: string
  type: SfSelectionType
  // Optional snapshot metadata captured from the search-result payload.
  // Populated by the SF pickers; consumed by ActivityForm to seed
  // ACV, sales stage, forecast category, close date, and the grayed-
  // out Amount display. Not persisted on this shape — the form maps
  // it onto its own state.
  extra?: {
    amount?: number | null
    closeDate?: string | null
    stageName?: string | null
    forecastCategoryName?: string | null
    ownerName?: string | null
    accountId?: string | null
    accountName?: string | null
  }
}

function iconForType(type: SfSelectionType) {
  switch (type) {
    case 'Opportunity': return TrendingUp
    case 'Account': return Building2
    case 'Contact': return User
    case 'Lead': return UserPlus
    case 'Campaign': return Megaphone
  }
}

interface SfCampaign {
  Id: string
  Name: string
  Status: string | null
  Type: string | null
  StartDate: string | null
  EndDate: string | null
  CreatedByName: string | null
  IsActive: boolean
  attendeeMatchCount?: number
}

interface SfSearchProps {
  value: SfSelection | null
  onChange: (selection: SfSelection | null) => void
  disabled?: boolean
  // Passed to the Campaign tab so we can find attendee-linked campaigns via
  // CampaignMember. Ignored by other tabs.
  attendeeEmails?: string[]
  // v1.270.0: Opportunities are IsClosed = false by default — this opts a
  // single search back into closed ones. Controlled by the caller (the
  // "Show Closed" checkbox sits next to the field's own label in
  // ActivityForm, not inside this popover) so unchecking it elsewhere
  // can't leave a stale true buried in this component's own state.
  showClosed?: boolean
  // Team whose field mappings shape the default Deal search on HubSpot
  // (the SE-owner properties). Salesforce ignores it.
  teamId?: string | null
}

type SearchTab = 'opportunities' | 'accounts' | 'leads' | 'campaigns'

export function SfSearch({ value, onChange, disabled, attendeeEmails, showClosed = false, teamId }: SfSearchProps) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const crmProvider = useCrmProvider()
  const apiBase = crmApiBaseFor(crmProvider)
  // Campaigns and Leads can each be switched off app-wide (Admin →
  // Integrations → CRM features); the tab disappears and the server
  // refuses the search.
  const { campaignsEnabled, leadsEnabled } = useCrmFeatures()
  const [tab, setTab] = useState<SearchTab>('opportunities')
  useEffect(() => {
    if ((!campaignsEnabled && tab === 'campaigns') || (!leadsEnabled && tab === 'leads')) setTab('opportunities')
  }, [campaignsEnabled, leadsEnabled, tab])
  const [query, setQuery] = useState('')
  const [openSearch, setOpenSearch] = useState(false)
  const [opps, setOpps] = useState<SfOpportunity[]>([])
  const [accounts, setAccounts] = useState<SfAccount[]>([])
  const [leads, setLeads] = useState<SfLead[]>([])
  const [campaigns, setCampaigns] = useState<SfCampaign[]>([])
  const [loading, setLoading] = useState(false)
  const [isStub, setIsStub] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    // Campaign tab can search purely on attendee-linked hits even without
    // any typed query. Other tabs still gate on 2+ chars.
    const canRunCampaignQuery = tab === 'campaigns' && (query.length >= 2 || (attendeeEmails ?? []).length > 0)
    if (query.length < 2 && !canRunCampaignQuery) {
      setOpps([]); setAccounts([]); setLeads([]); setCampaigns([])
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      const q = encodeURIComponent(query)
      if (tab === 'opportunities') {
        const res = await api.get<SfOpportunity[]>(`${apiBase}/search/opportunities?q=${q}&open=${openSearch}&showClosed=${showClosed}${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ''}`)
        setOpps(res.data ?? [])
        setIsStub(!!(res.meta as Record<string, unknown>)?.['stub'])
      } else if (tab === 'accounts') {
        const res = await api.get<SfAccount[]>(`${apiBase}/search/accounts?q=${q}`)
        setAccounts(res.data ?? [])
        setIsStub(!!(res.meta as Record<string, unknown>)?.['stub'])
      } else if (tab === 'leads') {
        const res = await api.get<SfLead[]>(`${apiBase}/search/leads?q=${q}`)
        setLeads(res.data ?? [])
        setIsStub(!!(res.meta as Record<string, unknown>)?.['stub'])
      } else if (tab === 'campaigns') {
        const emailsParam = (attendeeEmails ?? []).filter(Boolean).join(',')
        const url = `${apiBase}/search/campaigns?q=${q}${emailsParam ? `&attendeeEmails=${encodeURIComponent(emailsParam)}` : ''}`
        const res = await api.get<SfCampaign[]>(url)
        setCampaigns(res.data ?? [])
        setIsStub(!!(res.meta as Record<string, unknown>)?.['stub'])
      }
      setLoading(false)
    }, 350)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, tab, openSearch, showClosed, apiBase, teamId, (attendeeEmails ?? []).join(',')])

  // v1.94.0: fetch Account + Opportunity suggestions from attendee emails
  // when the popover opens with no typed query. Shows a "Suggested from
  // attendees" section above the tabs so the SE doesn't have to type any
  // characters to see plausible SF links. Falls back silently on no matches
  // or no SF connection.
  const [attendeeAccounts, setAttendeeAccounts] = useState<Array<{ Id: string; Name: string }>>([])
  const [attendeeOpps, setAttendeeOpps] = useState<Array<{ Id: string; Name: string; AccountId?: string | null; AccountName: string; StageName: string; Amount?: number | null; CloseDate?: string | null; ForecastCategoryName?: string | null; OwnerName?: string | null }>>([])
  useEffect(() => {
    // v1.95.0: fetch once whenever the attendee email set changes, not
    // gated on `open`. Previously the fetch cleared state on every popover
    // close/reopen, causing the "shows for a few seconds and then
    // disappears" symptom when React re-rendered the parent (e.g.
    // attendee-text parsing updating form.attendees). The popover render
    // still gates on `open`, so no visual difference when closed.
    const emails = (attendeeEmails ?? []).filter(Boolean)
    // Contact email → Account/Opportunity (Company/Deal on HubSpot).
    if (emails.length === 0 || crmProvider === 'none') { setAttendeeAccounts([]); setAttendeeOpps([]); return }
    let cancelled = false
    void api.get<{ accounts: Array<{ Id: string; Name: string }>; opportunities: Array<{ Id: string; Name: string; AccountId?: string | null; AccountName: string; StageName: string; Amount?: number | null; CloseDate?: string | null; ForecastCategoryName?: string | null; OwnerName?: string | null }> }>(`${crmApiBaseFor(crmProvider)}/search/from-attendees?emails=${encodeURIComponent(emails.join(','))}`).then((res) => {
      if (cancelled) return
      setAttendeeAccounts(res.data?.accounts ?? [])
      setAttendeeOpps(res.data?.opportunities ?? [])
    })
    return () => { cancelled = true }
  }, [crmProvider, (attendeeEmails ?? []).join(',')])

  const SelectedIcon = value ? iconForType(value.type) : null

  if (disabled && value && SelectedIcon) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700">
        <SelectedIcon className="h-3.5 w-3.5 text-blue-500" />
        <span className="flex-1 text-sm text-gray-900 dark:text-gray-100">{value.name}</span>
        <Badge variant={value.type === 'Opportunity' ? 'default' : 'secondary'}>{value.type}</Badge>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {value && SelectedIcon ? (
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700">
          <SelectedIcon className="h-3.5 w-3.5 text-blue-500" />
          <span className="flex-1 text-sm text-gray-900 dark:text-gray-100">{value.name}</span>
          <Badge variant={value.type === 'Opportunity' ? 'default' : 'secondary'}>{value.type}</Badge>
          {!disabled && (
            <button type="button" onClick={() => onChange(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            placeholder={t('activity.form.sf_search_placeholder')}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            className="pl-9"
            disabled={disabled}
          />
          {loading && <Spinner className="absolute right-3 top-2.5" />}
        </div>
      )}

      {/* v1.95.0: attendee-based suggestions stay visible whenever the
          popover is open + no SF Link is selected + no typed query. Once
          the user starts typing, the typed-results panel below takes
          over. Previously the section briefly rendered then vanished if
          the fetch resolved slightly late and the user was already
          typing. */}
      {open && !value && query.length < 2 && (attendeeAccounts.length > 0 || attendeeOpps.length > 0) && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-800/50 dark:text-gray-400">
            {t('activity.form.sf_from_attendees', 'Suggested from attendees')}
          </div>
          <ul className="max-h-72 overflow-y-auto py-1 text-sm">
            {attendeeOpps.map((o) => (
              <li key={`opp-${o.Id}`}>
                <button type="button" onClick={() => { onChange({ id: o.Id, name: o.Name, type: 'Opportunity', extra: { amount: o.Amount ?? null, closeDate: o.CloseDate ?? null, stageName: o.StageName, forecastCategoryName: o.ForecastCategoryName ?? null, ownerName: o.OwnerName ?? null, accountId: o.AccountId ?? null, accountName: o.AccountName } }); setOpen(false); setQuery('') }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800">
                  <TrendingUp className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-gray-900 dark:text-gray-100">{o.Name}{o.OwnerName && <span className="ml-1 text-[11px] font-normal text-gray-500 dark:text-gray-400">({o.OwnerName})</span>}</p>
                    <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">{o.AccountName} · {o.StageName}{o.CloseDate ? ` · ${t('sf.close_date_short', 'Closes')} ${o.CloseDate}` : ''}</p>
                  </div>
                </button>
              </li>
            ))}
            {attendeeAccounts.map((a) => (
              <li key={`acc-${a.Id}`}>
                <button type="button" onClick={() => { onChange({ id: a.Id, name: a.Name, type: 'Account' }); setOpen(false); setQuery('') }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                  <span className="truncate text-gray-900 dark:text-gray-100">{a.Name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && !value && query.length >= 2 && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {/* Tabs — Contact intentionally NOT here; SF Link is for the record
              the activity is *about* (Opp / Account / Lead). Individual
              contacts belong in the Attendees section instead, where they
              can be searched from SF filtered by the linked Account. */}
          <div className="flex border-b border-gray-200 dark:border-gray-700">
            <button
              type="button"
              className={cn('flex-1 px-2 py-2 text-xs font-medium', tab === 'opportunities' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400')}
              onClick={() => setTab('opportunities')}
            >
              <TrendingUp className="inline h-3 w-3 mr-1" />
              {t('sf.opportunity', { context: crmCtx })}
            </button>
            <button
              type="button"
              className={cn('flex-1 px-2 py-2 text-xs font-medium', tab === 'accounts' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400')}
              onClick={() => setTab('accounts')}
            >
              <Building2 className="inline h-3 w-3 mr-1" />
              {t('sf.account', { context: crmCtx })}
            </button>
            {leadsEnabled && (
            <button
              type="button"
              className={cn('flex-1 px-2 py-2 text-xs font-medium', tab === 'leads' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400')}
              onClick={() => setTab('leads')}
            >
              <UserPlus className="inline h-3 w-3 mr-1" />
              {t('sf.lead', { context: crmCtx })}
            </button>
            )}
            {campaignsEnabled && (
            <button
              type="button"
              className={cn('flex-1 px-2 py-2 text-xs font-medium', tab === 'campaigns' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400')}
              onClick={() => setTab('campaigns')}
            >
              <Megaphone className="inline h-3 w-3 mr-1" />
              {t('sf.campaign', { context: crmCtx })}
            </button>
            )}
          </div>

          {/* v1.122.0: hint explaining how Campaign/Lead picks
              associate to the Account — same copy the Account drill
              modal uses. Keeps the definitions consistent. */}
          {(tab === 'campaigns' || tab === 'leads') && (
            <div className="flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1 text-[10px] text-gray-500 dark:border-gray-800 dark:bg-gray-800/50 dark:text-gray-400">
              <span>
                {tab === 'campaigns'
                  ? t('sf_relationship.hint_campaign', { defaultValue: 'Campaigns roll up to an Account through their linked Opportunity.', context: crmCtx })
                  : t('sf_relationship.hint_lead', { defaultValue: 'Leads roll up to an Account only after they are converted.', context: crmCtx })}
              </span>
              <SfRelationshipHelp />
            </div>
          )}

          {/* My / Open search toggle (Opportunities only) */}
          {tab === 'opportunities' && (
            <div className="flex gap-2 border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
              <button
                type="button"
                className={cn('text-xs px-2 py-0.5 rounded', !openSearch ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400')}
                onClick={() => setOpenSearch(false)}
              >
                {t('activity.form.sf_my_opps')}
              </button>
              <button
                type="button"
                className={cn('text-xs px-2 py-0.5 rounded', openSearch ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400')}
                onClick={() => setOpenSearch(true)}
              >
                {t('activity.form.sf_open_search')}
              </button>
            </div>
          )}

          {isStub && (
            <div className="px-3 py-1 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40">
              Dev stub — connect Salesforce for real results
            </div>
          )}

          {/* Results */}
          <div className="max-h-52 overflow-y-auto">
            {tab === 'opportunities' && opps.length === 0 && !loading && (
              <p className="px-3 py-4 text-center text-xs text-gray-400">{t('sf.no_results')}</p>
            )}
            {tab === 'opportunities' && opps.map((opp) => (
              <button
                key={opp.Id}
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                onClick={() => { onChange({ id: opp.Id, name: opp.Name, type: 'Opportunity', extra: { amount: opp.Amount, closeDate: opp.CloseDate, stageName: opp.StageName, forecastCategoryName: opp.ForecastCategoryName, ownerName: opp.OwnerName, accountId: opp.AccountId ?? null, accountName: opp.AccountName } }); setOpen(false); setQuery('') }}
              >
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {opp.Name}
                  {opp.OwnerName && <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">({opp.OwnerName})</span>}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {opp.AccountName} · {opp.StageName}
                  {opp.CloseDate && <> · {t('sf.close_date_short', 'Closes')} {opp.CloseDate}</>}
                </span>
              </button>
            ))}
            {tab === 'accounts' && accounts.length === 0 && !loading && (
              <p className="px-3 py-4 text-center text-xs text-gray-400">{t('sf.no_results')}</p>
            )}
            {tab === 'accounts' && accounts.map((acct) => (
              <button
                key={acct.Id}
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                onClick={() => { onChange({ id: acct.Id, name: acct.Name, type: 'Account', extra: { ownerName: acct.OwnerName } }); setOpen(false); setQuery('') }}
              >
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {acct.Name}
                  {acct.OwnerName && <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">({acct.OwnerName})</span>}
                </span>
                {acct.Industry && <span className="text-xs text-gray-500 dark:text-gray-400">{acct.Industry}</span>}
              </button>
            ))}
            {tab === 'leads' && leads.length === 0 && !loading && (
              <p className="px-3 py-4 text-center text-xs text-gray-400">{t('sf.no_results')}</p>
            )}
            {tab === 'leads' && leads.map((l) => (
              <button
                key={l.Id}
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                onClick={() => { onChange({ id: l.Id, name: l.Name, type: 'Lead' }); setOpen(false); setQuery('') }}
              >
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{l.Name}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {[l.Company, l.Status, l.Email].filter(Boolean).join(' · ')}
                </span>
              </button>
            ))}
            {tab === 'campaigns' && campaigns.length === 0 && !loading && (
              <p className="px-3 py-4 text-center text-xs text-gray-400">{t('sf.no_results')}</p>
            )}
            {tab === 'campaigns' && campaigns.map((c) => (
              <button
                key={c.Id}
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                onClick={() => { onChange({ id: c.Id, name: c.Name, type: 'Campaign' }); setOpen(false); setQuery('') }}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                  {c.Name}
                  {c.attendeeMatchCount && c.attendeeMatchCount > 0 && (
                    <Badge variant="warning" className="text-[9px]" title={t('sf.campaign_attendee_match', 'Attendees on this meeting are members of this campaign')}>
                      {t('sf.attendee_match_count', { count: c.attendeeMatchCount, defaultValue: '{{count}} attendee' })}
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {[c.Type, c.Status].filter(Boolean).join(' · ')}
                  {!c.IsActive && <span className="ml-1 italic text-gray-400">(inactive)</span>}
                </span>
                {(c.StartDate || c.EndDate || c.CreatedByName) && (
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">
                    {(c.StartDate || c.EndDate) && (
                      <>{t('sf.campaign_dates', 'Dates')}: {c.StartDate ?? '—'} → {c.EndDate ?? '—'}</>
                    )}
                    {c.CreatedByName && <>{(c.StartDate || c.EndDate) ? ' · ' : ''}{t('sf.created_by', 'Created by')} {c.CreatedByName}</>}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
