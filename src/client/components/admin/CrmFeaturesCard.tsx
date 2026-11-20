import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, CalendarPlus, CheckCircle2, CircleSlash, Megaphone, Power, PowerOff, SlidersHorizontal, UserPlus, type LucideIcon } from 'lucide-react'
import { api, localizeError } from '../../lib/api.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { setCrmFeaturesState } from '../../store/crmFeatures.js'
import { useCrmProvider } from '../../store/crmProvider.js'
import { FULL_CRM_FEATURE_AVAILABILITY, effectiveCrmFeatures, type CrmFeatureAvailability, type CrmFeatures } from '../../../shared/crmFeatures.js'

// Admin → Integrations → CRM features. App-wide switches that apply to
// whichever CRM the install uses (Salesforce today). Turning a feature off
// hides it everywhere and the server refuses new links of that kind;
// nothing already saved is deleted, and nothing in the CRM is changed.
export function CrmFeaturesCard() {
  const { t } = useTranslation()
  const [features, setFeatures] = useState<CrmFeatures | null>(null)
  const [error, setError] = useState<string | null>(null)
  const provider = useCrmProvider()
  // What the CRM can offer. A HubSpot portal whose access check found no
  // Campaigns (Marketing Hub) or Leads keeps that feature hidden even with
  // its switch on, and the row says so.
  const [availability, setAvailability] = useState<CrmFeatureAvailability>(FULL_CRM_FEATURE_AVAILABILITY)

  function readAvailability(meta: Record<string, unknown>): CrmFeatureAvailability {
    const a = meta['availability'] as Partial<CrmFeatureAvailability> | undefined
    return { campaigns: a?.campaigns !== false, leads: a?.leads !== false }
  }

  useEffect(() => {
    void api.get<CrmFeatures>('/api/admin/integrations/crm-features').then((res) => {
      if (res.error) setError(localizeError(res.error))
      else { setFeatures(res.data ?? null); setAvailability(readAvailability(res.meta)) }
    })
  }, [])

  const [savingKey, setSavingKey] = useState<keyof CrmFeatures | null>(null)

  async function toggle(key: keyof CrmFeatures, offConfirmKey: string) {
    if (!features) return
    const next = !features[key]
    if (!next && !window.confirm(t(offConfirmKey))) return
    setSavingKey(key)
    setError(null)
    const res = await api.put<CrmFeatures>('/api/admin/integrations/crm-features', { [key]: next })
    setSavingKey(null)
    if (res.error || !res.data) { setError(localizeError(res.error) ?? t('errors.network')); return }
    const avail = readAvailability(res.meta)
    setFeatures(res.data)
    setAvailability(avail)
    setCrmFeaturesState(effectiveCrmFeatures(res.data, avail))
  }

  const rows: Array<{ key: keyof CrmFeatures; icon: LucideIcon; label: string; hint: string; offConfirm: string; available: boolean; unavailableHint: string }> = [
    { key: 'campaignsEnabled', icon: Megaphone, label: t('admin.integrations.crm_features.campaigns_label'), hint: t('admin.integrations.crm_features.campaigns_hint'), offConfirm: 'admin.integrations.crm_features.campaigns_off_confirm', available: availability.campaigns, unavailableHint: t('admin.integrations.crm_features.campaigns_unavailable_hubspot') },
    { key: 'leadsEnabled', icon: UserPlus, label: t('admin.integrations.crm_features.leads_label'), hint: t('admin.integrations.crm_features.leads_hint'), offConfirm: 'admin.integrations.crm_features.leads_off_confirm', available: availability.leads, unavailableHint: t('admin.integrations.crm_features.leads_unavailable_hubspot') },
    // HubSpot only: whether write-back may create meetings, or only fill in
    // the ones HubSpot's own calendar sync logged.
    ...(provider === 'hubspot'
      ? [{ key: 'hubspotCreateMeetings' as const, icon: CalendarPlus, label: t('admin.integrations.crm_features.hubspot_meetings_label'), hint: t('admin.integrations.crm_features.hubspot_meetings_hint'), offConfirm: 'admin.integrations.crm_features.hubspot_meetings_off_confirm', available: true, unavailableHint: '' }]
      : []),
  ]

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-gray-100 p-2 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          <SlidersHorizontal className="h-4 w-4" />
        </div>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.crm_features.title')}</p>
          <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.crm_features.description')}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!features && !error ? (
        <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
      ) : features && rows.map((row) => {
        const enabled = features[row.key]
        const Icon = row.icon
        return (
        <div key={row.key} className="flex items-start justify-between gap-3 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
          <div className="flex items-start gap-2">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{row.label}</p>
              <p className="mt-0.5 max-w-prose text-xs text-gray-500 dark:text-gray-400">{row.hint}</p>
              {enabled && !row.available && (
                <p className="mt-1 flex max-w-prose items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{row.unavailableHint}</span>
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={enabled ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
              {enabled ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
              {enabled ? t('admin.integrations.crm_features.on') : t('admin.integrations.crm_features.off')}
            </Badge>
            <Button size="sm" variant="outline" onClick={() => { void toggle(row.key, row.offConfirm) }} disabled={savingKey !== null}>
              {savingKey === row.key ? <Spinner className="mr-1 h-3.5 w-3.5" /> : enabled ? <PowerOff className="mr-1 h-3.5 w-3.5" /> : <Power className="mr-1 h-3.5 w-3.5" />}
              {enabled ? t('admin.integrations.crm_features.turn_off') : t('admin.integrations.crm_features.turn_on')}
            </Button>
          </div>
        </div>
        )
      })}
    </div>
  )
}
