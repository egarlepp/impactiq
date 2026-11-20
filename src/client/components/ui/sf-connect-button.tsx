import { useTranslation } from 'react-i18next'
import { useCrmProvider } from '../../store/crmProvider.js'
import { Cloud, CloudOff, CalendarDays, CalendarOff, Loader2 } from 'lucide-react'
import { useSalesforce } from '../../hooks/useSalesforce.js'
import { useCrmMe } from '../../hooks/useCrmMe.js'
import { useState, useCallback, useEffect } from 'react'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'

interface MsStatus {
  connected: boolean
  configured: boolean
}

function useMicrosoftStatus() {
  const [status, setStatus] = useState<MsStatus | null>(null)
  const reload = useCallback(async () => {
    try {
      const res = await api.get<MsStatus>('/auth/microsoft/status')
      setStatus(res.data ?? { connected: false, configured: false })
    } catch {
      setStatus({ connected: false, configured: false })
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { status }
}

function NavConnectBtn({
  collapsed,
  configured,
  connected,
  connecting,
  connectingLabel,
  connectedLabel,
  notConfiguredLabel,
  connectLabel,
  instanceTitle,
  ConnectedIcon,
  DisconnectedIcon,
  onClick,
}: {
  collapsed: boolean
  configured: boolean
  connected: boolean
  connecting: boolean
  connectingLabel: string
  connectedLabel: string
  notConfiguredLabel: string
  connectLabel: string
  instanceTitle?: string | null
  ConnectedIcon: React.ComponentType<{ className?: string }>
  DisconnectedIcon: React.ComponentType<{ className?: string }>
  onClick: () => void
}) {
  if (connecting) {
    return (
      <button className={cn('flex w-full items-center rounded-md py-2 text-xs text-gray-400 dark:text-gray-500', collapsed ? 'justify-center px-0' : 'gap-2 px-3')} disabled>
        <Loader2 className={cn(collapsed ? 'h-5 w-5' : 'h-3.5 w-3.5', 'shrink-0 animate-spin')} />
        {!collapsed && <span>{connectingLabel}</span>}
      </button>
    )
  }

  if (!configured) {
    return (
      <div
        className={cn('flex w-full items-center rounded-md py-2 text-xs text-gray-400 dark:text-gray-500', collapsed ? 'justify-center px-0' : 'gap-2 px-3')}
        title={notConfiguredLabel}
      >
        <DisconnectedIcon className={cn(collapsed ? 'h-5 w-5' : 'h-3.5 w-3.5', 'shrink-0')} />
        {!collapsed && <span className="truncate">{notConfiguredLabel}</span>}
      </div>
    )
  }

  if (connected) {
    return (
      <button
        onClick={onClick}
        className={cn('flex w-full items-center rounded-md py-2 text-xs text-green-700 transition-colors hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950/40', collapsed ? 'justify-center px-0' : 'gap-2 px-3')}
        title={instanceTitle ?? (collapsed ? connectedLabel : undefined)}
      >
        <ConnectedIcon className={cn(collapsed ? 'h-5 w-5' : 'h-3.5 w-3.5', 'shrink-0')} />
        {!collapsed && <span className="truncate">{connectedLabel}</span>}
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      className={cn('flex w-full items-center rounded-md py-2 text-xs text-blue-700 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40', collapsed ? 'justify-center px-0' : 'gap-2 px-3')}
      title={collapsed ? connectLabel : undefined}
    >
      <DisconnectedIcon className={cn(collapsed ? 'h-5 w-5' : 'h-3.5 w-3.5', 'shrink-0')} />
      {!collapsed && <span>{connectLabel}</span>}
    </button>
  )
}

export function SfConnectButton({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation()
  const { status: crmStatus, loading: sfLoading, connect: sfConnect, disconnect: sfDisconnect } = useSalesforce()
  const { status: msStatus } = useMicrosoftStatus()
  // Another CRM, or none, is chosen in Admin → Integrations: Salesforce
  // isn't usable here, so read as "CRM not configured".
  const crm = useCrmProvider()
  const sfIsCrm = crm === 'salesforce'
  // HubSpot has no per-user sign-in: "connected" means the install's HubSpot
  // connection is saved and this user matches a HubSpot owner. Either way the
  // button opens My Settings, which explains the match.
  const { status: hsMe, loading: hsLoading } = useCrmMe()

  function handleSfClick() {
    if (crmStatus?.connected) {
      if (window.confirm(t('sf.connect.disconnect_confirm'))) void sfDisconnect()
    } else {
      sfConnect()
    }
  }

  function handleMsClick() {
    window.location.assign('/auth/microsoft')
  }

  return (
    <>
      {crm === 'hubspot' ? (
      <NavConnectBtn
        collapsed={collapsed}
        configured={hsMe?.configured ?? false}
        connected={!!hsMe?.configured && !!hsMe.owner}
        connecting={hsLoading}
        connectingLabel="…"
        connectedLabel={t('sf.connect.hubspot_connected')}
        notConfiguredLabel={t('sf.connect.not_configured')}
        connectLabel={t('sf.connect.hubspot_not_matched')}
        instanceTitle={hsMe?.owner ? (hsMe.owner.name ?? hsMe.owner.email) : null}
        ConnectedIcon={Cloud}
        DisconnectedIcon={CloudOff}
        onClick={() => window.location.assign('/settings')}
      />
      ) : (
      <NavConnectBtn
        collapsed={collapsed}
        configured={sfIsCrm && (crmStatus?.configured ?? false)}
        connected={sfIsCrm && (crmStatus?.connected ?? false)}
        connecting={sfLoading || !crmStatus}
        connectingLabel="…"
        connectedLabel={t('sf.connect.connected')}
        notConfiguredLabel={t('sf.connect.not_configured')}
        connectLabel={t('sf.connect.connect')}
        instanceTitle={crmStatus?.instanceUrl}
        ConnectedIcon={Cloud}
        DisconnectedIcon={CloudOff}
        onClick={handleSfClick}
      />
      )}
      <NavConnectBtn
        collapsed={collapsed}
        configured={msStatus?.configured ?? false}
        connected={msStatus?.connected ?? false}
        connecting={!msStatus}
        connectingLabel="…"
        connectedLabel={t('calendar.connected')}
        notConfiguredLabel={t('calendar.not_configured')}
        connectLabel={t('calendar.connect')}
        ConnectedIcon={CalendarDays}
        DisconnectedIcon={CalendarOff}
        onClick={handleMsClick}
      />
    </>
  )
}
