import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link2Off, ExternalLink, ArrowUpRight } from 'lucide-react'
import { api } from '../../lib/api.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useCrmLabelContext, useCrmProvider, useCrmRecordLinkBase } from '../../store/crmProvider.js'
import { HUBSPOT_OBJECT_TYPE_IDS, isHubspotProjectObject } from '../../../shared/hubspot.js'
import { format } from 'date-fns'

interface BrokenLink {
  linkType: 'What' | 'Who' | 'Related'
  objectType: string | null
  lastKnownName: string | null
  lastKnownId: string | null
}

interface Row {
  id: string
  title: string
  startDatetime: string
  ownerId: string
  ownerName: string
  teamId: string
  teamName: string
  subtypeName: string | null
  crmDisconnectCheckedAt: string | null
  brokenLinks: BrokenLink[]
}

interface Props { teamId: string; memberIds?: string[] }

// v1.344.0: table dashboard listing every submitted activity whose linked
// Salesforce What/Who/Related record has been deleted — see CLAUDE.md §7.
// Reads only local Postgres (batch-computed by the nightly
// detect_disconnected_links job), so it's fast and works for every viewer
// regardless of their own SF connection. Deliberately no date/cost/compare
// filters — a broken link is either broken right now or it isn't,
// independent of when the activity happened.
export function SfDisconnected({ teamId, memberIds = [] }: Props) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const crmProvider = useCrmProvider()
  const crmCtx = useCrmLabelContext()
  const hubspotLinkBase = useCrmRecordLinkBase()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setRows(null)
    api.get<Row[]>(buildDashboardUrl('sf-disconnected', { teamId, memberIds }))
      .then((res) => setRows(res.data ?? null))
      .finally(() => setLoading(false))
  }, [teamId, memberIds.join(',')])

  // HubSpot record pages are keyed by object type id (Deal 0-3, Company 0-2…).
  function hubspotObjectTypeId(objectType: string): string | null {
    if (objectType === 'Opportunity') return HUBSPOT_OBJECT_TYPE_IDS.deals
    if (objectType === 'Account') return HUBSPOT_OBJECT_TYPE_IDS.companies
    if (objectType === 'Contact') return HUBSPOT_OBJECT_TYPE_IDS.contacts
    if (objectType === 'Lead') return '0-136'
    return isHubspotProjectObject(objectType) ? objectType : null
  }

  function sfLink(objectType: string | null, id: string | null): string | null {
    if (!objectType || !id) return null
    if (crmProvider === 'hubspot') {
      const typeId = hubspotObjectTypeId(objectType)
      return hubspotLinkBase && typeId ? `${hubspotLinkBase}/${typeId}/${encodeURIComponent(id)}` : null
    }
    if (crmProvider !== 'salesforce' || !user?.sfInstanceUrl) return null
    return `${user.sfInstanceUrl.replace(/\/$/, '')}/lightning/r/${objectType}/${id}/view`
  }

  // The object's name as people know it in the active CRM: a HubSpot Project
  // link stores an object type id ('0-970', '2-…'), not a name.
  function objectLabel(objectType: string | null): string {
    if (!objectType) return '—'
    if (objectType === 'Opportunity') return t('sf.opportunity', { context: crmCtx })
    if (objectType === 'Account') return t('sf.account', { context: crmCtx })
    if (objectType === 'Lead') return t('sf.lead')
    if (crmProvider === 'hubspot' && isHubspotProjectObject(objectType)) return t('leader.project_costing.col_project')
    return objectType
  }

  function linkTypeLabel(linkType: BrokenLink['linkType']): string {
    if (linkType === 'What') return t('leader.sf_disconnected.link_what', 'What')
    if (linkType === 'Who') return t('leader.sf_disconnected.link_who', 'Who')
    return t('leader.sf_disconnected.link_related', 'Related')
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('leader.sf_disconnected.description', { defaultValue: 'Activities whose linked Salesforce record (Account, Opportunity, Campaign, Contact, Lead, or a Related record) could not be found — most likely because it was deleted in Salesforce. Checked nightly, plus live whenever the activity is opened.', context: crmCtx })}
      </p>

      {loading && <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>}
      {!loading && rows === null && <DashboardEmptyState />}
      {rows && rows.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
          {t('leader.sf_disconnected.empty', { defaultValue: 'No disconnected activities found — every linked Salesforce record is reachable.', context: crmCtx })}
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">{t('leader.sf_disconnected.col_activity', 'Activity')}</th>
                <th className="px-3 py-2 text-left">{t('leader.sf_disconnected.col_owner', 'Owner')}</th>
                <th className="px-3 py-2 text-left">{t('leader.sf_disconnected.col_team', 'Team')}</th>
                <th className="px-3 py-2 text-left">{t('leader.sf_disconnected.col_date', 'Date')}</th>
                <th className="px-3 py-2 text-left">{t('leader.sf_disconnected.col_broken_links', 'Broken Link(s)')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const dayKey = format(new Date(r.startDatetime), 'yyyy-MM-dd')
                return (
                  <tr key={r.id} className="border-b border-gray-100 align-top dark:border-gray-900 last:border-b-0">
                    <td className="px-3 py-2">
                      <a
                        href={`/activities?openActivityId=${r.id}&startDate=${dayKey}`}
                        className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {r.title}
                        <ArrowUpRight className="h-3 w-3 shrink-0" />
                      </a>
                      {r.subtypeName && (
                        <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{r.subtypeName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.ownerName}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.teamName}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">{dayKey}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        {r.brokenLinks.map((bl, i) => {
                          const href = sfLink(bl.objectType, bl.lastKnownId)
                          return (
                            <span
                              key={i}
                              className="inline-flex w-fit items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                            >
                              <Link2Off className="h-3 w-3 shrink-0" />
                              <span className="font-medium">{linkTypeLabel(bl.linkType)}</span>
                              <span className="text-rose-500 dark:text-rose-400">{objectLabel(bl.objectType)}</span>
                              {href ? (
                                <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
                                  {bl.lastKnownName ?? bl.lastKnownId}
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </a>
                              ) : (
                                <span>{bl.lastKnownName ?? bl.lastKnownId}</span>
                              )}
                            </span>
                          )
                        })}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
