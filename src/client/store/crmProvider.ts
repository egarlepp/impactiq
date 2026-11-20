import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api.js'
import { applyCrmWording } from '../i18n/index.js'
import { DEFAULT_CRM_PROVIDER, crmWordingVariables, normalizeCrmProvider, type CrmProviderId } from '../../shared/crmProvider.js'

// Which CRM the install uses (Admin → Integrations → CRM). Fetched once per
// page load on first use and shared by every component; the admin card calls
// setCrmProviderState() after a change. Until the fetch answers, Salesforce
// applies, matching the server's default.
let current: CrmProviderId = DEFAULT_CRM_PROVIDER
// HubSpot only: where record pages live in the portal
// (https://{domain}/contacts/{portalId}/record), for ticket links.
let recordLinkBase: string | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setCrmProviderState(next: CrmProviderId) {
  current = next
  applyCrmWording(next)
  listeners.forEach((cb) => { cb() })
}

function ensureLoaded() {
  if (loading) return
  loading = api.get<{ provider: CrmProviderId; recordLinkBase?: string | null }>('/api/crm/provider').then((res) => {
    if (res.data) {
      recordLinkBase = typeof res.data.recordLinkBase === 'string' ? res.data.recordLinkBase : null
      setCrmProviderState(normalizeCrmProvider(res.data))
    }
    else loading = null
  }).catch(() => { loading = null })
}

export function useCrmProvider(): CrmProviderId {
  useEffect(() => { ensureLoaded() }, [])
  return useSyncExternalStore(subscribe, () => current, () => current)
}

// A HubSpot record's page: {base}/{objectTypeId}/{id} (0-5 = tickets).
// Null for Salesforce, or before the portal is known.
export function useCrmRecordLinkBase(): string | null {
  const provider = useCrmProvider()
  return provider === 'hubspot' ? recordLinkBase : null
}

// Where CRM search and hover-preview calls go. Salesforce keeps its own
// /api/salesforce routes (with their dev stubs); any other CRM uses the
// CRM-neutral /api/crm routes, which talk to whichever CRM is active.
export function crmApiBaseFor(provider: CrmProviderId): string {
  return provider === 'salesforce' ? '/api/salesforce' : '/api/crm'
}

// Non-hook read for module-level fetchers (the hover-preview cache). Any
// screen showing a CRM link has already loaded the provider via a hook.
export function crmApiBase(): string {
  ensureLoaded()
  return crmApiBaseFor(current)
}

export function useCrmApiBase(): string {
  return crmApiBaseFor(useCrmProvider())
}

// The CRM's name needs no context: strings use {{crm}} / {{crmShort}}, set
// globally from the active CRM (i18n/index.ts applyCrmWording). Context is for
// wording that differs beyond the name, e.g. object names: such keys carry a
// variant suffixed with the CRM id (sf.opportunity_hubspot = "Deal"); passing
// this context to t() picks it, and falls back to the plain key (Salesforce's
// words) for Salesforce, for "none", and for any key without a variant.
//   const crmCtx = useCrmLabelContext()
//   t('sf.opportunity', { context: crmCtx })
export function crmLabelContextFor(provider: CrmProviderId): string | undefined {
  return provider === 'salesforce' || provider === 'none' ? undefined : provider
}

export function useCrmLabelContext(): string | undefined {
  return crmLabelContextFor(useCrmProvider())
}

// For a screen that shows one CRM's data whichever CRM is active (CRM Field
// Mappings' Salesforce/HubSpot toggle): t() with {{crm}} / {{crmShort}} and
// the label context set for `crm` instead of the active CRM.
export function useCrmViewTranslation(crm: CrmProviderId) {
  const { t: tBase } = useTranslation()
  const t = useMemo(() => {
    const vars = crmWordingVariables(crm)
    const wrapped = (key: string | string[], a?: unknown, b?: unknown) => {
      if (typeof a === 'string') return tBase(key, { ...vars, ...(b as Record<string, unknown> | undefined), defaultValue: a })
      return tBase(key, { ...vars, ...(a as Record<string, unknown> | undefined) })
    }
    return wrapped as unknown as typeof tBase
  }, [tBase, crm])
  return { t, crmCtx: crmLabelContextFor(crm) }
}
