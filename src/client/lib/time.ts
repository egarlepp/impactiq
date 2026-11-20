import type { TFunction } from 'i18next'

/**
 * Localised "N minutes ago" style formatter for the SF sync pill and any
 * other timestamp we want to render compactly. Prefers narrow buckets
 * (just now / minutes / hours / yesterday / days / weeks) and falls back
 * to an absolute date once we're past ~4 weeks.
 *
 * All strings resolve through the passed-in `t` — never hard-code English.
 * The token in the "older" bucket is `{{date}}` which we localise via
 * `toLocaleDateString()`.
 */
export function formatRelativeTime(input: string | Date | null | undefined, t: TFunction): string {
  if (!input) return ''
  const d = typeof input === 'string' ? new Date(input) : input
  if (!d || Number.isNaN(d.getTime())) return ''
  const now = Date.now()
  const diffMs = now - d.getTime()
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return t('activity.sync.relative.just_now')
  const min = Math.round(sec / 60)
  if (min < 60) return t('activity.sync.relative.minutes', { count: min })
  const hr = Math.round(min / 60)
  if (hr < 24) return t('activity.sync.relative.hours', { count: hr })
  const day = Math.round(hr / 24)
  if (day === 1) return t('activity.sync.relative.yesterday')
  if (day < 7) return t('activity.sync.relative.days', { count: day })
  if (day < 30) {
    const wk = Math.round(day / 7)
    return t('activity.sync.relative.weeks', { count: wk })
  }
  return t('activity.sync.relative.older', { date: d.toLocaleDateString() })
}
