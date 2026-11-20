import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useNotifications, SEVERITY_STYLES } from './notifications.js'
import { linkifyText } from '../../lib/linkify.js'
import { DynamicIcon } from './icon-picker.js'
import { useTheme } from '../../store/theme.js'
import { cn } from '../../lib/utils.js'

// Top-header banner for admin/leader-posted announcements (kind === 'announcement'
// on the shared notifications table). Reuses the SAME poll/cache useNotifications()
// already runs for the bell — no second request. Shown regardless of isRead (only
// Dismiss removes one; marking read has no effect here since there's no bell-style
// "read" affordance in this surface) — see CLAUDE.md's Announcements writeup for why
// dismiss doubles as the daily reset for a recurring announcement.
export function AnnouncementBanner() {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { items, dismiss } = useNotifications()
  const [dismissing, setDismissing] = useState<Set<string>>(new Set())
  const announcements = items.filter((n) => n.kind === 'announcement' && !dismissing.has(n.id))

  // Reset the local "in flight" set if the underlying item actually left the
  // cache (dismiss succeeded) so a later re-post of the same id isn't stuck hidden.
  useEffect(() => {
    setDismissing((cur) => {
      const stillPresent = new Set([...cur].filter((id) => items.some((n) => n.id === id)))
      return stillPresent.size === cur.size ? cur : stillPresent
    })
  }, [items])

  if (announcements.length === 0) return null

  async function handleDismiss(id: string) {
    setDismissing((s) => new Set(s).add(id))
    await dismiss(id)
  }

  return (
    <div className="flex flex-col gap-1 border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-900/60">
      {announcements.map((n) => {
        const sev = SEVERITY_STYLES[n.severity ?? 'info'] ?? SEVERITY_STYLES['info']!
        // Custom icon is header-banner-only (never the bell or the bottom
        // toast — see notifications.tsx) and resolves its color against the
        // VIEWER'S own current theme, live, rather than a CSS dark: class —
        // useTheme() is already resolved to a concrete 'light'|'dark' by
        // render time, so no dark-mode class-duplication trick is needed.
        // No custom color for the current theme → still custom icon shape,
        // but severity-tinted so it's never an undefined default color.
        const customColor = n.icon ? (theme === 'dark' ? n.iconColorDark : n.iconColorLight) ?? null : null
        return (
          <div
            key={n.id}
            className={`flex items-start gap-2 border-l-2 px-2 py-1 text-xs ${sev.border}`}
          >
            {n.icon ? (
              <DynamicIcon
                name={n.icon}
                className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', !customColor && sev.text)}
                style={customColor ? { color: customColor } : undefined}
              />
            ) : (
              <sev.Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${sev.text}`} />
            )}
            <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-200">{linkifyText(n.message)}</span>
            <button
              type="button"
              onClick={() => void handleDismiss(n.id)}
              className="mt-0.5 rounded p-0.5 text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
              aria-label={t('announcement.dismiss', 'Dismiss')}
              title={t('announcement.dismiss_tip', 'Dismiss — hides this announcement. It may reappear tomorrow if the admin set it to recur daily.')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
