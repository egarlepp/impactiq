import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, CircleSlash, Copy, Power, PowerOff, RefreshCw, Zap } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'

export interface CriteriaIqLiveRefreshSummary {
  enabled: boolean
  secretHint: string | null
  lastWebhookAt: string | null
}

const ENDPOINT_PATH = '/api/webhooks/criteriaiq'

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-gray-50 px-2 py-1 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">{value}</code>
        <Button
          size="sm"
          variant="outline"
          title={t('admin.integrations.criteriaiq.live_refresh.copy')}
          aria-label={t('admin.integrations.criteriaiq.live_refresh.copy')}
          onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true)) }}
        >
          {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

// Admin → Integrations → CriteriaIQ connection → Live refresh (v1.450.0).
// Makes or rotates the secret CriteriaIQ signs its webhook with, and shows
// the endpoint URL to paste into a CriteriaIQ webhook.
export function CriteriaIqLiveRefresh({ summary, onChange }: { summary: CriteriaIqLiveRefreshSummary; onChange: (next: CriteriaIqLiveRefreshSummary) => void }) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState<'enable' | 'disable' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const endpoint = `${window.location.origin}${ENDPOINT_PATH}`

  async function enable() {
    if (summary.enabled && !window.confirm(t('admin.integrations.criteriaiq.live_refresh.rotate_confirm'))) return
    setBusy('enable'); setError(null)
    const res = await api.post<{ secret: string; summary: { liveRefresh: CriteriaIqLiveRefreshSummary } }>('/api/admin/integrations/criteriaiq/live-refresh', {})
    setBusy(null)
    if (res.error || !res.data) { setError(res.error ?? t('errors.network')); return }
    setSecret(res.data.secret)
    onChange(res.data.summary.liveRefresh)
  }

  async function disable() {
    if (!window.confirm(t('admin.integrations.criteriaiq.live_refresh.turn_off_confirm'))) return
    setBusy('disable'); setError(null)
    const res = await api.delete<{ liveRefresh: CriteriaIqLiveRefreshSummary }>('/api/admin/integrations/criteriaiq/live-refresh')
    setBusy(null)
    if (res.error || !res.data) { setError(res.error ?? t('errors.network')); return }
    setSecret(null)
    onChange(res.data.liveRefresh)
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
            <Zap className="h-4 w-4 text-amber-500 dark:text-amber-400" />
            {t('admin.integrations.criteriaiq.live_refresh.title')}
          </p>
          <p className="mt-0.5 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.criteriaiq.live_refresh.description')}</p>
        </div>
        <Badge variant={summary.enabled ? 'success' : 'secondary'} className="inline-flex shrink-0 items-center gap-1">
          {summary.enabled ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
          {summary.enabled ? t('admin.integrations.crm_features.on') : t('admin.integrations.crm_features.off')}
        </Badge>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {summary.enabled && (
        <>
          <CopyRow label={t('admin.integrations.criteriaiq.live_refresh.endpoint_label')} value={endpoint} />
          {secret ? (
            <>
              <CopyRow label={t('admin.integrations.criteriaiq.live_refresh.secret_label')} value={secret} />
              <p className="text-xs text-amber-700 dark:text-amber-300">{t('admin.integrations.criteriaiq.live_refresh.secret_once')}</p>
            </>
          ) : (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {t('admin.integrations.criteriaiq.live_refresh.secret_on_file', { hint: summary.secretHint ?? '' })}
            </p>
          )}
          <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.criteriaiq.live_refresh.setup')}</p>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {summary.lastWebhookAt
              ? t('admin.integrations.criteriaiq.live_refresh.last_received', { when: new Date(summary.lastWebhookAt).toLocaleString(i18n.language) })
              : t('admin.integrations.criteriaiq.live_refresh.never_received')}
          </p>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={summary.enabled ? 'outline' : 'default'} onClick={() => { void enable() }} disabled={busy !== null}>
          {busy === 'enable' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : summary.enabled ? <RefreshCw className="mr-1 h-3.5 w-3.5" /> : <Power className="mr-1 h-3.5 w-3.5" />}
          {summary.enabled ? t('admin.integrations.criteriaiq.live_refresh.rotate') : t('admin.integrations.criteriaiq.live_refresh.turn_on')}
        </Button>
        {summary.enabled && (
          <Button size="sm" variant="outline" onClick={() => { void disable() }} disabled={busy !== null}>
            {busy === 'disable' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <PowerOff className="mr-1 h-3.5 w-3.5" />}
            {t('admin.integrations.criteriaiq.live_refresh.turn_off')}
          </Button>
        )}
      </div>
    </div>
  )
}
