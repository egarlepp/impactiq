import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, Lock, Save, UserCheck, Users } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { MultiSelect } from '../ui/multi-select.js'
import { Spinner } from '../ui/spinner.js'
import { MAX_DEAL_EDIT_PROPERTIES, type HubspotDealEditMode, type HubspotDealEditPolicy } from '../../../shared/hubspotDealEdit.js'

interface DealProperty { apiName: string; label: string; type: string }

// Admin → Integrations → HubSpot → Who can edit Deals (v1.424.0, security
// audit M4). ImpactIQ writes to HubSpot with the portal-wide key, so this
// setting decides who may change a Deal's Assigned SE and editable Deal
// fields from ImpactIQ.
export function HubspotDealEditSection() {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState<HubspotDealEditPolicy | null>(null)
  const [props, setProps] = useState<DealProperty[] | null>(null)
  const [propsError, setPropsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.get<HubspotDealEditPolicy>('/api/admin/integrations/hubspot/deal-edit').then((res) => {
      if (res.error) setError(res.error)
      else if (res.data) setPolicy(res.data)
    })
    void api.get<{ fields: DealProperty[] }>('/api/admin/hubspot/properties?object=deals').then((res) => {
      if (res.error) setPropsError(res.error)
      else setProps(res.data?.fields ?? [])
    })
  }, [])

  async function save() {
    if (!policy) return
    setSaving(true); setError(null); setSaved(false)
    const res = await api.put<HubspotDealEditPolicy>('/api/admin/integrations/hubspot/deal-edit', policy)
    setSaving(false)
    if (res.error) { setError(res.error); return }
    if (res.data) setPolicy(res.data)
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  const setMode = (mode: HubspotDealEditMode) => policy && setPolicy({ ...policy, mode })
  // Properties already chosen stay listed even if HubSpot no longer returns them.
  const options = [
    ...(props ?? []).map((p) => ({ value: p.apiName, label: p.label, hint: p.apiName })),
    ...(policy?.properties ?? []).filter((n) => !(props ?? []).some((p) => p.apiName === n)).map((n) => ({ value: n, label: n })),
  ]
  const needsProperty = policy?.mode === 'named_on_deal' && policy.properties.length === 0

  return (
    <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
      <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
        <Lock className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        {t('admin.integrations.hubspot.deal_edit.title')}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.deal_edit.hint')}</p>
      {!policy ? (
        error ? <p className="text-xs text-red-600 dark:text-red-400">{t(error)}</p> : <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
      ) : (
        <>
          <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="radio" name="hubspot-deal-edit" className="mt-0.5" checked={policy.mode === 'any_matched_user'} onChange={() => setMode('any_matched_user')} />
            <span>
              <span className="inline-flex items-center gap-1 font-medium"><Users className="h-3.5 w-3.5" />{t('admin.integrations.hubspot.deal_edit.mode_any')}</span>
              <span className="block text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.deal_edit.mode_any_hint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="radio" name="hubspot-deal-edit" className="mt-0.5" checked={policy.mode === 'named_on_deal'} onChange={() => setMode('named_on_deal')} />
            <span>
              <span className="inline-flex items-center gap-1 font-medium"><UserCheck className="h-3.5 w-3.5" />{t('admin.integrations.hubspot.deal_edit.mode_named')}</span>
              <span className="block text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.deal_edit.mode_named_hint')}</span>
            </span>
          </label>
          {policy.mode === 'named_on_deal' && (
            <div className="flex flex-col gap-1 pl-5">
              {propsError ? (
                <p className="text-xs text-red-600 dark:text-red-400">{t(propsError)}</p>
              ) : !props ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <MultiSelect
                  label={t('admin.integrations.hubspot.deal_edit.properties_label')}
                  labelIcon={ListChecks}
                  options={options}
                  selected={policy.properties}
                  onChange={(next) => setPolicy({ ...policy, properties: next.slice(0, MAX_DEAL_EDIT_PROPERTIES) })}
                  placeholder={t('admin.integrations.hubspot.deal_edit.properties_placeholder')}
                />
              )}
              <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.deal_edit.properties_hint', { max: MAX_DEAL_EDIT_PROPERTIES })}</p>
              {needsProperty && <p className="text-[11px] text-amber-700 dark:text-amber-400">{t('errors.hubspot.deal_edit_needs_property')}</p>}
            </div>
          )}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{t(error)}</p>}
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => { void save() }} disabled={saving || needsProperty}>
              {saving ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
            {saved && <span className="text-xs text-green-600 dark:text-green-400">{t('common.saved')}</span>}
          </div>
        </>
      )}
    </div>
  )
}
