// Maps the app's i18n language codes to date-fns Locale objects, so any
// date-fns format() call that renders human copy (month names, weekday
// abbreviations, etc.) matches the interface language instead of always
// rendering in English.
import { de, es, fr, it, ja, pt } from 'date-fns/locale'
import type { Locale } from 'date-fns'

const LOCALES: Record<string, Locale> = { de, es, fr, it, ja, pt }

export function getDateFnsLocale(language: string): Locale | undefined {
  const base = language.split('-')[0] ?? language
  return LOCALES[base]
}
