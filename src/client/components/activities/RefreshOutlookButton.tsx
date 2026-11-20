import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'

// v1.91.0: manual "Refresh from Outlook" button. Client-throttled to one
// click per 10 minutes so users can nudge a live Graph sync without
// hammering the shared quota; the server enforces its own per-user
// freshness check in syncUserCalendar as a second guardrail.
//
// Countdown is shown in whole minutes in the button's title/aria-label so
// the user sees "Refresh available in 4 min" when they hover a disabled
// button. Timestamp lives in localStorage so the throttle survives page
// reloads on the same device.

const THROTTLE_MS = 10 * 60 * 1000
const STORAGE_KEY = 'outlook_refresh_last_at'

function readLast(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

export function RefreshOutlookButton({ onRefreshed }: { onRefreshed: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())
  const last = readLast()
  const nextAvailableAt = last ? last + THROTTLE_MS : 0
  const remainingMs = Math.max(0, nextAvailableAt - now)
  const disabled = busy || remainingMs > 0

  // While throttled, tick every second so the mm:ss countdown in the tooltip
  // stays live. (When enabled, no interval runs.)
  useEffect(() => {
    if (remainingMs === 0) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [remainingMs])

  const totalSec = Math.ceil(remainingMs / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  const remainingLabel = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`

  const clickRefresh = useCallback(async () => {
    if (disabled) return
    setBusy(true)
    try {
      await api.post('/api/outlook/refresh', {})
      try { localStorage.setItem(STORAGE_KEY, String(Date.now())) } catch { /* storage quota — ignore */ }
      onRefreshed()
      setNow(Date.now())
    } finally {
      setBusy(false)
    }
  }, [disabled, onRefreshed])

  const title = disabled && remainingMs > 0
    ? t('activity.refresh_outlook.wait', 'Refresh available in {{time}}', { time: remainingLabel })
    : t('activity.refresh_outlook.title', 'Refresh from Outlook')

  // A disabled <button> doesn't fire hover events, so its own title tooltip
  // never appears. Wrap it in a titled span so the countdown shows on hover
  // even while the button is throttled.
  return (
    <span title={title} className="inline-flex">
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void clickRefresh()}
        disabled={disabled}
        aria-label={title}
        className="text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/40 dark:hover:text-blue-300"
      >
        {busy ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
      </Button>
    </span>
  )
}
