import type { i18n as I18n, TFunction } from 'i18next'

// Server errors come back as i18n keys like `errors.password_reused`. Look
// them up if the current bundle has them, otherwise fall back to English if
// a translation exists there, and finally to the raw string (covers ad-hoc
// client-side strings like "Network error" that were never i18n keys).
// Shared so every page that renders a raw `res.error` string agrees on how
// to translate it, instead of each page inventing its own version.
export function translateServerError(t: TFunction, i18nInstance: I18n, raw: string | null | undefined): string {
  if (!raw) return ''
  if (i18nInstance.exists(raw)) return t(raw)
  if (i18nInstance.exists(raw, { lng: 'en' })) return t(raw, { lng: 'en' })
  return raw
}
