import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en/translation.json' with { type: 'json' }
import de from './locales/de/translation.json' with { type: 'json' }
import fr from './locales/fr/translation.json' with { type: 'json' }
import es from './locales/es/translation.json' with { type: 'json' }
import ja from './locales/ja/translation.json' with { type: 'json' }
import pt from './locales/pt/translation.json' with { type: 'json' }
import it from './locales/it/translation.json' with { type: 'json' }
import { crmWordingVariables, DEFAULT_CRM_PROVIDER, type CrmProviderId } from '../../shared/crmProvider.js'
import { DEFAULT_TERMINOLOGY, terminologyWordingVariables, type Terminology } from '../../shared/terminology.js'

// Supported languages — English is the only one with a complete translation
// today; the others fall back to English at the resource level until their
// JSON files land. Listing them here lets the UI offer the language picker
// and keeps i18next happy when a user picks an unfilled language.
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'ja', label: '日本語' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
] as const

const STORAGE_KEY = 'impactiq_language'
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
    fr: { translation: fr },
    es: { translation: es },
    ja: { translation: ja },
    pt: { translation: pt },
    it: { translation: it },
  } as Record<string, { translation: Record<string, unknown> }>,
  lng: stored ?? 'en',
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
  // {{crm}} / {{crmShort}} name the install's CRM in every string; see
  // applyCrmWording() below. {{evalTerm}} / {{evalWork}} are the org's word
  // for an evaluation; see applyTerminologyWording().
  interpolation: {
    escapeValue: false,
    defaultVariables: { ...crmWordingVariables(DEFAULT_CRM_PROVIDER), ...terminologyWordingVariables(DEFAULT_TERMINOLOGY) },
  },
})

i18n.on('languageChanged', (lng) => {
  try { localStorage.setItem(STORAGE_KEY, lng) } catch { /* SSR / private mode */ }
})

// Point {{crm}} / {{crmShort}} at the CRM chosen in Admin → Integrations, then
// re-render every translated component (react-i18next re-renders on
// languageChanged). Called by the CRM provider store whenever it learns or
// changes the CRM.
export function applyCrmWording(provider: CrmProviderId) {
  const next = crmWordingVariables(provider)
  const interp = i18n.options.interpolation ?? (i18n.options.interpolation = {})
  const cur = interp.defaultVariables ?? {}
  if (cur['crm'] === next.crm && cur['crmShort'] === next.crmShort) return
  interp.defaultVariables = { ...cur, ...next }
  i18n.emit('languageChanged', i18n.language)
}

// Point {{evalTerm}} / {{evalWork}} at Admin → Workplace → Terminology ("POx"
// / "POx Work" until the setting loads), the same way as applyCrmWording().
export function applyTerminologyWording(terminology: Terminology) {
  const next = terminologyWordingVariables(terminology)
  const interp = i18n.options.interpolation ?? (i18n.options.interpolation = {})
  const cur = interp.defaultVariables ?? {}
  if (cur['evalTerm'] === next.evalTerm && cur['evalWork'] === next.evalWork) return
  interp.defaultVariables = { ...cur, ...next }
  i18n.emit('languageChanged', i18n.language)
}

export default i18n
