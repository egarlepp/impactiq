import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, CircleSlash, Gauge, Lock, Network, Save } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { CollapsibleCard } from './CollapsibleCard.js'

interface RateLimitSettings { enabled: boolean; windowSeconds: number; max: number; trustedProxyHops: number }
interface RateLimitMeta {
  proxyHopsFromEnv: number | null
  request: { ip: string | null; forwardedFor: string | null; proxyHeaderSeen: boolean }
}

const PROXY_HOP_CHOICES = [0, 1, 2, 3]

// Admin → Integrations → Rate Limiting. Configures the GLOBAL per-IP limiter
// (applied to all API/auth traffic). Per-route limiters (login, MFA, MCP,
// calendar refresh) stack tighter caps on top and aren't controlled here.
export function RateLimitConfig() {
  const { t } = useTranslation()
  const [data, setData] = useState<RateLimitSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [meta, setMeta] = useState<RateLimitMeta | null>(null)

  useEffect(() => {
    void api.get<RateLimitSettings>('/api/admin/rate-limit').then((res) => {
      if (res.data) setData(res.data)
      setMeta((res.meta as unknown as RateLimitMeta | undefined) ?? null)
    })
  }, [])

  async function save() {
    if (!data) return
    setSaving(true); setErr(null); setSaved(false)
    const res = await api.put<RateLimitSettings>('/api/admin/rate-limit', data)
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    if (res.data) setData(res.data)
    setMeta((res.meta as unknown as RateLimitMeta | undefined) ?? null)
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  // Collapsed by default; the header shows whether the limit is on.
  const badges = data && (
    <Badge variant={data.enabled ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
      {data.enabled ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
      {data.enabled ? t('admin.integrations.state_active') : t('admin.integrations.state_inactive')}
    </Badge>
  )

  return (
    <CollapsibleCard
      icon={Gauge}
      title={t('admin.rate_limit.title', 'Rate Limiting')}
      description={t('admin.rate_limit.subtitle', 'Global per-IP request limit across all API endpoints. Login, MFA, MCP, and calendar refresh have their own tighter limits on top.')}
      badges={badges}
    >

      {!data ? (
        <div className="flex justify-center py-4"><Spinner className="h-4 w-4" /></div>
      ) : (
        <>
          <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={data.enabled} onChange={(e) => setData({ ...data, enabled: e.target.checked })} className="mt-0.5 h-4 w-4" />
            <span>
              <span className="font-semibold">{t('admin.rate_limit.enabled_label', 'Enable global rate limiting')}</span>
              <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">{t('admin.rate_limit.enabled_hint', 'When off, no global limit is applied (per-route limits still apply).')}</span>
            </span>
          </label>

          <div className="grid max-w-md grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">{t('admin.rate_limit.max_label', 'Max requests')}</Label>
              <Input type="number" min={1} max={1000000} value={data.max} disabled={!data.enabled}
                onChange={(e) => setData({ ...data, max: Number(e.target.value) })} className="h-8 text-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">{t('admin.rate_limit.window_label', 'Per window (seconds)')}</Label>
              <Input type="number" min={10} max={3600} value={data.windowSeconds} disabled={!data.enabled}
                onChange={(e) => setData({ ...data, windowSeconds: Number(e.target.value) })} className="h-8 text-xs" />
            </div>
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            {t('admin.rate_limit.summary', 'Up to {{max}} requests per {{seconds}}s per IP address.', { max: data.max, seconds: data.windowSeconds })}
          </p>

          <div className="flex flex-col gap-1 border-t border-gray-200 pt-3 dark:border-gray-700">
            <Label className="inline-flex items-center gap-1 text-[11px]">
              <Network className="h-3.5 w-3.5" />
              {t('admin.rate_limit.proxy_hops_label')}
            </Label>
            <select
              value={meta?.proxyHopsFromEnv ?? data.trustedProxyHops}
              disabled={meta?.proxyHopsFromEnv != null}
              onChange={(e) => setData({ ...data, trustedProxyHops: Number(e.target.value) })}
              className="h-8 max-w-xs rounded border border-gray-300 bg-white px-2 text-xs text-gray-900 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              {PROXY_HOP_CHOICES.map((n) => (
                <option key={n} value={n}>{n === 0 ? t('admin.rate_limit.proxy_hops_none') : t('admin.rate_limit.proxy_hops_count', { count: n })}</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.rate_limit.proxy_hops_hint')}</p>
            {meta?.proxyHopsFromEnv != null && (
              <p className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
                <Lock className="h-3 w-3" />
                {t('admin.rate_limit.proxy_hops_env', { count: meta.proxyHopsFromEnv })}
              </p>
            )}
            {meta && (
              <p className="text-[11px] text-gray-600 dark:text-gray-300">
                {meta.request.forwardedFor
                  ? t('admin.rate_limit.proxy_seen', { chain: meta.request.forwardedFor, ip: meta.request.ip ?? '—' })
                  : t('admin.rate_limit.proxy_seen_none', { ip: meta.request.ip ?? '—' })}
              </p>
            )}
            {meta && meta.request.proxyHeaderSeen && (meta.proxyHopsFromEnv ?? data.trustedProxyHops) === 0 && (
              <p className="inline-flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {t('admin.rate_limit.proxy_warn_header')}
              </p>
            )}
          </div>

          {err && <p className="text-xs text-red-600 dark:text-red-400">{t(err, 'Could not save.')}</p>}
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save', 'Save')}
            </Button>
            {saved && <span className="text-xs text-green-600 dark:text-green-400">{t('common.saved', 'Saved')}</span>}
          </div>
        </>
      )}
    </CollapsibleCard>
  )
}
