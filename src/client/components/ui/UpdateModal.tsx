import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ArrowUpCircle, CheckCircle2, RefreshCw, GitBranch, Settings as SettingsIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { Button } from './button.js'
import { Spinner } from './spinner.js'
import { ChangelogHighlights } from './changelog-highlights.js'
import { APP_VERSION } from '../../lib/version.js'
import type { ChangelogItem } from '../../../shared/changelogCategories.js'

export interface UpdateCheckStatus {
  checkedAt: string | null
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  newEntries: Array<{ version: string; date: string; highlights: ChangelogItem[] }>
  error: string | null
}

// v1.332.0: App Update info modal — opened from the sidebar's Update pill
// (see nav.tsx). Phase 1 is deliberately read-only/informational: shows
// whether a newer version exists on the pinned branch and what changed,
// plus (default-admin only) a live "Check now" button. No redeploy/restart
// trigger yet — that's Phase 2, intentionally not built here. See
// CLAUDE.md and rbac.ts for the trust-boundary writeup.
export function UpdateModal({
  isDefaultAdmin,
  onClose,
}: {
  isDefaultAdmin: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [status, setStatus] = useState<UpdateCheckStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [pinnedBranch, setPinnedBranch] = useState<string | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)

  async function load() {
    const [statusRes, settingsRes] = await Promise.all([
      api.get<UpdateCheckStatus | null>('/api/admin/updates/status'),
      api.get<{ configured: boolean; pinnedBranch: string }>('/api/admin/updates/settings'),
    ])
    setStatus(statusRes.data ?? null)
    setPinnedBranch(settingsRes.data?.pinnedBranch ?? 'main')
    setConfigured(settingsRes.data?.configured ?? false)
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  async function checkNow() {
    setChecking(true)
    const res = await api.post<UpdateCheckStatus>('/api/admin/updates/check-now', {})
    setChecking(false)
    if (res.data) setStatus(res.data)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('updates.modal.title')}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800/50">
                <p className="text-gray-500 dark:text-gray-400">{t('updates.modal.current_version', { version: APP_VERSION })}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5 text-gray-400" />
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t('updates.modal.pinned_branch', { branch: pinnedBranch ?? 'main' })}</span>
                </div>
              </div>

              {!configured ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('updates.modal.not_configured')}</p>
              ) : status?.error ? (
                <p className="text-sm text-red-600 dark:text-red-400">{t('updates.modal.check_error', { error: status.error })}</p>
              ) : status?.updateAvailable ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300">
                    <ArrowUpCircle className="h-4 w-4" />
                    {t('updates.modal.update_available', { version: status.latestVersion })}
                  </p>
                  <div className="mt-2 space-y-2">
                    {status.newEntries.map((e) => (
                      <div key={e.version} className="rounded border border-amber-100 bg-white/60 p-2 text-xs dark:border-amber-900/60 dark:bg-black/20">
                        <div className="flex items-center justify-between font-semibold text-gray-800 dark:text-gray-200">
                          <span>v{e.version}</span>
                          <span className="text-gray-400">{e.date}</span>
                        </div>
                        <ChangelogHighlights items={e.highlights} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('updates.modal.up_to_date')}
                </p>
              )}

              {status?.checkedAt && (
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {t('updates.modal.last_checked', { when: new Date(status.checkedAt).toLocaleString() })}
                </p>
              )}

              {!isDefaultAdmin && (
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('updates.modal.default_admin_only')}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          {isDefaultAdmin ? (
            <>
              <Button size="sm" variant="outline" onClick={() => { onClose(); navigate('/admin?section=integrations') }}>
                <SettingsIcon className="mr-1 h-3.5 w-3.5" />{t('updates.modal.configure')}
              </Button>
              <Button size="sm" onClick={checkNow} disabled={checking || !configured}>
                {checking ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                {t('updates.modal.check_now')}
              </Button>
            </>
          ) : (
            <span />
          )}
        </div>
      </div>
    </div>
  )
}
