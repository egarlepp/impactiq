import type { HubspotCapabilityReport, HubspotConnectionSummary } from '../../../shared/hubspot.js'
import { getCrmProviderSetting } from '../crm/providerSetting.js'
import { countCrmLinkedData, hasCrmLinkedData } from '../crm/providerLock.js'
import { checkHubspotCapabilities, inspectHubspotToken } from './capabilities.js'
import { HubspotError } from './client.js'
import { clearHubspotConfig, getHubspotConfig, saveHubspotCheck, setHubspotConfig, type HubspotPortalInfo } from './config.js'
import { clearHubspotOwners, getHubspotOwnerMatchSummary } from './owners.js'

// What Admin → Integrations → HubSpot reads and writes (HubSpot plan, phase
// 2a). Routes stay thin; the rules live here so they can be tested.

export async function getHubspotConnectionSummary(): Promise<HubspotConnectionSummary> {
  const [cfg, owners] = await Promise.all([getHubspotConfig(), getHubspotOwnerMatchSummary()])
  return {
    configured: cfg !== null,
    tokenHint: cfg ? cfg.accessToken.slice(-4) : null,
    portalId: cfg?.portalId ?? null,
    portalName: cfg?.portalName ?? null,
    accountType: cfg?.accountType ?? null,
    uiDomain: cfg?.uiDomain ?? null,
    lastCheck: cfg?.lastCheck ?? null,
    owners,
  }
}

// Whether a token for `nextPortal` may replace the saved one. Record ids are
// per portal, so once the install holds HubSpot-linked data a token for a
// different portal would leave every link pointing at records that portal
// doesn't have. A portal that can't be named (no account-info access) can't
// be compared, and is allowed.
export function hubspotPortalChangeAllowed(savedPortal: number | null, nextPortal: number | null, holdsHubspotData: boolean): boolean {
  if (!holdsHubspotData || savedPortal === null || nextPortal === null) return true
  return savedPortal === nextPortal
}

export type SaveHubspotTokenResult =
  | { ok: true; portal: HubspotPortalInfo; portalChanged: boolean }
  | { ok: false; status: 400 | 409 | 502; error: string }

// Checks the token with HubSpot before storing it; a rejected token is never
// saved. A new portal clears the old portal's owner list.
export async function saveHubspotToken(token: string): Promise<SaveHubspotTokenResult> {
  let portal: HubspotPortalInfo
  try {
    portal = await inspectHubspotToken(token)
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.hubspot.unreachable'
    return { ok: false, status: code === 'errors.hubspot.unauthorized' ? 400 : 502, error: code }
  }
  const saved = await getHubspotConfig()
  const setting = await getCrmProviderSetting()
  const holdsHubspotData = setting.dataProvider === 'hubspot' && hasCrmLinkedData(await countCrmLinkedData())
  if (!hubspotPortalChangeAllowed(saved?.portalId ?? null, portal.portalId, holdsHubspotData)) {
    return { ok: false, status: 409, error: 'errors.hubspot.portal_locked' }
  }
  const portalChanged = !!saved && saved.portalId !== portal.portalId
  await setHubspotConfig(token, portal)
  if (portalChanged) await clearHubspotOwners()
  return { ok: true, portal, portalChanged }
}

export type RemoveHubspotResult = { ok: true } | { ok: false; status: 409; error: 'errors.hubspot.in_use' }

// HubSpot can't be disconnected while it's the install's CRM: switch the CRM
// to None first (Admin → Integrations → CRM).
export async function removeHubspotConnection(): Promise<RemoveHubspotResult> {
  const setting = await getCrmProviderSetting()
  if (setting.provider === 'hubspot') return { ok: false, status: 409, error: 'errors.hubspot.in_use' }
  await clearHubspotConfig()
  await clearHubspotOwners()
  return { ok: true }
}

// Runs the capability check with the saved token and keeps the result.
export async function runHubspotCapabilityCheck(): Promise<HubspotCapabilityReport> {
  const cfg = await getHubspotConfig()
  if (!cfg) throw new HubspotError('errors.hubspot.not_configured')
  const report = await checkHubspotCapabilities({ token: cfg.accessToken, portalId: cfg.portalId })
  await saveHubspotCheck(report)
  return report
}
