import { and, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activityCrmTickets, crmHistoricalEvents } from '../../../../drizzle/schema.js'
import { CRITERIAIQ_RELATED_TYPE } from '../../../shared/evaluationSource.js'
import { crmProviderChangeAllowed, type CrmProviderId, type CrmProviderSetting } from '../../../shared/crmProvider.js'
import { getCrmProviderSetting, writeCrmProviderSetting } from './providerSetting.js'
import { availableCrmProviderIds } from './index.js'
import { isHubspotConfigured } from '../hubspot/config.js'
import { isSalesforceConfigured } from '../auth/salesforce.js'

// Record ids from one CRM mean nothing in another, so once an install holds
// CRM-linked data it can't switch to a different CRM: activities would point
// at ids the new CRM doesn't have. Switching between the data's own CRM and
// 'none' stays allowed, since that leaves every link valid.
//
// "CRM-linked data" is anything holding a CRM record id: an activity linked
// to a record (What, Who, a CRM Related record) or written back to one, an attached
// support ticket, or an imported historical event.
export interface CrmLinkedDataCounts {
  activities: number
  tickets: number
  historicalEvents: number
}

export async function countCrmLinkedData(): Promise<CrmLinkedDataCounts> {
  const [[a], [tk], [h]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(activities).where(or(
      isNotNull(activities.crmWhatId),
      isNotNull(activities.crmWhoId),
      // A CriteriaIQ project link (CriteriaIQ as the Project source) holds a
      // CriteriaIQ id, not a CRM one.
      and(isNotNull(activities.crmRelatedId), sql`coalesce(${activities.crmRelatedType}, '') <> ${CRITERIAIQ_RELATED_TYPE}`),
      isNotNull(activities.crmRecordId),
    )),
    db.select({ n: sql<number>`count(*)` }).from(activityCrmTickets),
    db.select({ n: sql<number>`count(*)` }).from(crmHistoricalEvents),
  ])
  // count(*) is bigint, which the postgres driver returns as a string.
  return { activities: Number(a?.n ?? 0), tickets: Number(tk?.n ?? 0), historicalEvents: Number(h?.n ?? 0) }
}

export function hasCrmLinkedData(c: CrmLinkedDataCounts): boolean {
  return c.activities + c.tickets + c.historicalEvents > 0
}

export interface CrmProviderState extends CrmProviderSetting {
  available: CrmProviderId[]
  linkedData: CrmLinkedDataCounts
  locked: boolean
  // Whether each CRM's connection is saved. Choosing a CRM never needs it
  // (v1.407.0); the admin card warns when the chosen one isn't set up yet.
  configured: Record<Exclude<CrmProviderId, 'none'>, boolean>
}

export async function getCrmProviderState(): Promise<CrmProviderState> {
  const [setting, linkedData, hubspot] = await Promise.all([getCrmProviderSetting(), countCrmLinkedData(), isHubspotConfigured()])
  return {
    ...setting,
    available: availableCrmProviderIds(),
    linkedData,
    locked: hasCrmLinkedData(linkedData),
    configured: { salesforce: isSalesforceConfigured(), hubspot },
  }
}

export type ChangeCrmProviderResult =
  | { ok: true; before: CrmProviderSetting; after: CrmProviderSetting }
  | { ok: false; status: 400 | 409; error: 'errors.crm.provider_not_available' | 'errors.crm.provider_locked' }

export async function changeCrmProvider(to: CrmProviderId): Promise<ChangeCrmProviderResult> {
  if (!availableCrmProviderIds().includes(to)) return { ok: false, status: 400, error: 'errors.crm.provider_not_available' }
  const before = await getCrmProviderSetting()
  if (to === before.provider) return { ok: true, before, after: before }
  const linked = hasCrmLinkedData(await countCrmLinkedData())
  if (!crmProviderChangeAllowed(before, to, linked)) return { ok: false, status: 409, error: 'errors.crm.provider_locked' }
  // A CRM can be chosen before its connection is saved, same for every CRM:
  // until it is, its routes answer "not configured" and its jobs stand down,
  // and Admin → Integrations → CRM says so.
  // With no linked data yet, the data's CRM follows the new choice; with
  // data, it stays (the only allowed moves keep it valid).
  const dataProvider = to !== 'none' && !linked ? to : before.dataProvider
  const after = await writeCrmProviderSetting({ provider: to, dataProvider })
  return { ok: true, before, after }
}
