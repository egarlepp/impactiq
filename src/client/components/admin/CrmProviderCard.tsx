import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, Ban, CheckCircle2, Cloud, Database, Info, Lock, Unlock, type LucideIcon } from 'lucide-react'
import { api, localizeError } from '../../lib/api.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { CollapsibleCard } from './CollapsibleCard.js'
import { setCrmProviderState, useCrmProvider } from '../../store/crmProvider.js'
import { crmProviderChangeAllowed, type CrmProviderId } from '../../../shared/crmProvider.js'

interface CrmProviderState {
  provider: CrmProviderId
  dataProvider: Exclude<CrmProviderId, 'none'>
  available: CrmProviderId[]
  linkedData: { activities: number; tickets: number; historicalEvents: number }
  locked: boolean
  configured: Record<Exclude<CrmProviderId, 'none'>, boolean>
}

type CrmId = Exclude<CrmProviderId, 'none'>

// The CRM this install is locked to (records already link to it), or null
// while unlocked. Shared with the connection cards inside the CRM group so the
// other CRM's card can show it can't be used instead of offering a setup form.
const CrmLockContext = createContext<CrmId | null>(null)

// The CRM that locks `crm` out, or null when `crm` can still be chosen (or no
// CRM is given). Only meaningful inside <CrmProviderCard>.
export function useCrmLockedOut(crm: CrmId | null): CrmId | null {
  const lockedTo = useContext(CrmLockContext)
  return crm && lockedTo && lockedTo !== crm ? lockedTo : null
}

const OPTIONS: Array<{ id: CrmProviderId; icon: LucideIcon }> = [
  { id: 'salesforce', icon: Cloud },
  { id: 'hubspot', icon: Database },
  { id: 'none', icon: Ban },
]

// Admin → Integrations → CRM. Which CRM this install uses: one or the other,
// never both. Once activities or other records link to CRM records, the
// install can only move between that CRM and "None"; ids from one CRM mean
// nothing in another.
//
// It is also the CRM group on the page: the CRM connection cards, the admin
// Salesforce connection and CRM features sit inside it as `children`, so the
// whole group expands and collapses together. The header keeps the current
// CRM and the lock visible while collapsed.
//
// Any CRM can be chosen before its connection is set up (v1.407.0); the card
// then warns that it isn't configured. `refreshKey` changes whenever a CRM
// connection card below saves or clears, so that warning stays current.
export function CrmProviderCard({ children, refreshKey }: { children?: ReactNode; refreshKey?: number }) {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<CrmProviderState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<CrmProviderId | null>(null)

  useEffect(() => {
    void api.get<CrmProviderState>('/api/admin/integrations/crm-provider').then((res) => {
      if (res.error) setError(localizeError(res.error))
      else setState(res.data ?? null)
    })
  }, [refreshKey])

  const name = (id: CrmProviderId) => t(`admin.integrations.crm_provider.option_${id}`)

  async function choose(id: CrmProviderId) {
    if (!state || id === state.provider) return
    const confirmText = t('admin.integrations.crm_provider.change_confirm', { from: name(state.provider), to: name(id) })
    const unconfigured = id !== 'none' && !state.configured[id]
    if (!window.confirm(unconfigured
      ? `${confirmText}\n\n${t('admin.integrations.crm_provider.change_confirm_unconfigured', { name: name(id) })}`
      : confirmText)) return
    setSaving(id)
    setError(null)
    const res = await api.put<CrmProviderState>('/api/admin/integrations/crm-provider', { provider: id })
    setSaving(null)
    if (res.error || !res.data) { setError(localizeError(res.error) ?? t('errors.network')); return }
    setState(res.data)
    setCrmProviderState(res.data.provider)
  }

  const linkedTotal = state ? state.linkedData.activities + state.linkedData.tickets + state.linkedData.historicalEvents : 0

  const CurrentIcon = state ? (OPTIONS.find((o) => o.id === state.provider)?.icon ?? Cloud) : Cloud
  const badges = state && (
    <>
      <Badge variant={state.provider === 'none' ? 'secondary' : 'success'} className="inline-flex items-center gap-1">
        <CurrentIcon className="h-3 w-3" />
        {name(state.provider)}
      </Badge>
      <Badge variant={state.locked ? 'secondary' : 'success'} className="inline-flex items-center gap-1">
        {state.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
        {state.locked ? t('admin.integrations.crm_provider.locked') : t('admin.integrations.crm_provider.unlocked')}
      </Badge>
    </>
  )

  return (
    <CollapsibleCard
      icon={Cloud}
      title={t('admin.integrations.crm_provider.title')}
      description={t('admin.integrations.crm_provider.description')}
      badges={badges}
    >
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!state && !error ? (
        <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
      ) : state && (
        <>
          <div className="flex flex-wrap gap-2">
            {OPTIONS.map(({ id, icon: Icon }) => {
              const current = id === state.provider
              const available = state.available.includes(id)
              const allowed = crmProviderChangeAllowed(state, id, state.locked)
              const reason = !available
                ? t('admin.integrations.crm_provider.not_available_yet')
                : !allowed
                  ? t('admin.integrations.crm_provider.locked_reason', { crm: name(state.dataProvider) })
                  : undefined
              return (
                <Button
                  key={id}
                  size="sm"
                  variant={current ? 'default' : 'outline'}
                  disabled={!current && (!available || !allowed || saving !== null)}
                  title={reason}
                  aria-pressed={current}
                  onClick={() => { void choose(id) }}
                >
                  {saving === id ? <Spinner className="mr-1 h-3.5 w-3.5" /> : current ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <Icon className="mr-1 h-3.5 w-3.5" />}
                  {name(id)}
                  {!available && <span className="ml-1 text-[10px] opacity-70">({t('admin.integrations.crm_provider.coming_soon')})</span>}
                </Button>
              )
            })}
          </div>
          {state.provider !== 'none' && !state.configured[state.provider] && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('admin.integrations.crm_provider.not_configured_warning', { name: name(state.provider) })}</span>
            </div>
          )}
          <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">
            {state.locked
              ? t('admin.integrations.crm_provider.locked_body', {
                crm: name(state.dataProvider),
                activities: state.linkedData.activities.toLocaleString(i18n.language),
                tickets: state.linkedData.tickets.toLocaleString(i18n.language),
                historical: state.linkedData.historicalEvents.toLocaleString(i18n.language),
              })
              : t('admin.integrations.crm_provider.unlocked_body')}
          </p>
          {state.locked && OPTIONS.filter((o) => o.id !== 'none' && o.id !== state.dataProvider && state.available.includes(o.id)).map((o) => (
            <div key={o.id} className="flex items-start gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('admin.integrations.crm_provider.locked_other_body', { other: name(o.id), locked: name(state.dataProvider) })}</span>
            </div>
          ))}
          {linkedTotal === 0 && state.provider === 'none' && (
            <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.crm_provider.none_body')}</p>
          )}
        </>
      )}
      <CrmLockContext.Provider value={state?.locked ? state.dataProvider : null}>
        {children}
      </CrmLockContext.Provider>
    </CollapsibleCard>
  )
}

// Shown inside a CRM's connection card while that CRM isn't the one chosen
// above: it can be set up now and is only used once chosen.
export function InactiveCrmNote({ crm }: { crm: CrmId }) {
  const { t } = useTranslation()
  const active = useCrmProvider()
  if (active === crm) return null
  const name = t(`admin.integrations.crm_provider.option_${crm}`)
  return (
    <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {active === 'none'
          ? t('admin.integrations.crm_provider.inactive_note_none', { name })
          : t('admin.integrations.crm_provider.inactive_note_other', { name, active: t(`admin.integrations.crm_provider.option_${active}`) })}
      </span>
    </div>
  )
}

// Replaces a CRM connection card's setup form while the install is locked to
// the other CRM: its connection could be saved but never used.
export function CrmLockedOutNote({ crm, lockedTo }: { crm: CrmId; lockedTo: CrmId }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {t('admin.integrations.crm_provider.locked_out_note', {
          name: t(`admin.integrations.crm_provider.option_${crm}`),
          locked: t(`admin.integrations.crm_provider.option_${lockedTo}`),
        })}
      </span>
    </div>
  )
}
