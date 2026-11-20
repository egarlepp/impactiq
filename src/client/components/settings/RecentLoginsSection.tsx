import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'

interface LoginRow {
  id: string
  success: boolean
  failureReason: string | null
  method: string
  ip: string | null
  userAgent: string | null
  isSuspicious: boolean
  createdAt: string
}

function summariseUA(ua: string | null): string {
  if (!ua) return '—'
  const chrome = /Chrome\/([\d.]+)/.exec(ua)
  const firefox = /Firefox\/([\d.]+)/.exec(ua)
  const safari = /Version\/([\d.]+).*Safari/.exec(ua)
  const os = /Mac OS X|Windows|Linux|iPhone|iPad|Android/.exec(ua)
  const browser = chrome ? `Chrome ${chrome[1]?.split('.')[0]}` : firefox ? `Firefox ${firefox[1]?.split('.')[0]}` : safari ? `Safari ${safari[1]?.split('.')[0]}` : ua.slice(0, 40)
  return `${browser}${os ? ` · ${os[0]}` : ''}`
}

export function RecentLoginsSection() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<LoginRow[] | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await api.get<LoginRow[]>('/auth/me/logins')
      setRows((res.data ?? []).slice(0, 10))
    })()
  }, [])

  if (!rows) return <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-gray-400">{t('settings.recent_logins.empty')}</p>

  return (
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2">{t('settings.recent_logins.col_when')}</th>
            <th className="px-3 py-2">{t('settings.recent_logins.col_method')}</th>
            <th className="px-3 py-2">{t('settings.recent_logins.col_ip')}</th>
            <th className="px-3 py-2">{t('settings.recent_logins.col_device')}</th>
            <th className="px-3 py-2">{t('settings.recent_logins.col_status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-b border-gray-100 dark:border-gray-900 last:border-b-0 ${!r.success ? 'bg-red-50/50 dark:bg-red-950/20' : r.isSuspicious ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''}`}>
              <td className="px-3 py-2 text-xs whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
              <td className="px-3 py-2 font-mono text-xs uppercase">{r.method}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.ip ?? '—'}</td>
              <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{summariseUA(r.userAgent)}</td>
              <td className="px-3 py-2 text-xs">
                {!r.success ? (
                  <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
                    <ShieldAlert className="h-3 w-3" />
                    {t('settings.recent_logins.status_failed')}
                    {r.failureReason ? <span className="text-gray-500">· {r.failureReason}</span> : null}
                  </span>
                ) : r.isSuspicious ? (
                  <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                    <ShieldAlert className="h-3 w-3" />
                    {t('settings.recent_logins.status_new_ip')}
                  </span>
                ) : (
                  <span className="text-green-700 dark:text-green-400">{t('settings.recent_logins.status_success')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
