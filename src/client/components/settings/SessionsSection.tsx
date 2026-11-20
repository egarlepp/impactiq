import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LogOut, Monitor } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'

interface SessionRow {
  id: string
  ip: string | null
  userAgent: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  isCurrent: boolean
}

function summariseUA(ua: string | null): string {
  if (!ua) return '—'
  // Cheap heuristic — good enough for the "which device is this" question.
  const chrome = /Chrome\/([\d.]+)/.exec(ua)
  const firefox = /Firefox\/([\d.]+)/.exec(ua)
  const safari = /Version\/([\d.]+).*Safari/.exec(ua)
  const os = /Mac OS X|Windows|Linux|iPhone|iPad|Android/.exec(ua)
  const browser = chrome ? `Chrome ${chrome[1]?.split('.')[0]}` : firefox ? `Firefox ${firefox[1]?.split('.')[0]}` : safari ? `Safari ${safari[1]?.split('.')[0]}` : ua.slice(0, 40)
  return `${browser}${os ? ` · ${os[0]}` : ''}`
}

export function SessionsSection() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function reload() {
    const res = await api.get<SessionRow[]>('/auth/sessions')
    setRows(res.data ?? [])
  }
  useEffect(() => { void reload() }, [])

  async function revoke(id: string) {
    setBusy(true)
    await api.delete(`/auth/sessions/${id}`)
    await reload()
    setBusy(false)
  }
  async function revokeOthers() {
    if (!window.confirm(t('settings.sessions.revoke_others_confirm'))) return
    setBusy(true)
    await api.delete('/auth/sessions')
    await reload()
    setBusy(false)
  }

  const others = (rows ?? []).filter((r) => !r.isCurrent)

  return (
    <div className="flex flex-col gap-3">
      {!rows ? <Spinner className="h-4 w-4" /> : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                <div className="flex items-center gap-3">
                  <Monitor className="h-4 w-4 text-gray-400" />
                  <div>
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {summariseUA(r.userAgent)}
                      {r.isCurrent && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-800 dark:bg-green-900/40 dark:text-green-300">{t('settings.sessions.this_device')}</span>}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {r.ip ?? '—'} · {t('settings.sessions.last_active', { when: new Date(r.lastUsedAt).toLocaleString() })}
                    </div>
                  </div>
                </div>
                {!r.isCurrent && (
                  <Button size="sm" variant="outline" onClick={() => revoke(r.id)} disabled={busy}>
                    <LogOut className="mr-1 h-3 w-3" />{t('settings.sessions.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {others.length > 0 && (
            <div>
              <Button size="sm" variant="outline" onClick={revokeOthers} disabled={busy}>
                {t('settings.sessions.revoke_others', { count: others.length })}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
