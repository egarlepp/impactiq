import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'
// v1.360.0: the user-facing preference now includes 'system' (follow OS),
// distinct from the resolved `Theme` every existing dark:/JS-conditional
// consumer already expects — `useTheme().theme` stays a plain 'light'|'dark'
// so none of those call sites need to change.
export type ThemePreference = Theme | 'system'

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getInitialPreference(): ThemePreference {
  const stored = localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system'
}

function resolve(pref: ThemePreference): Theme {
  return pref === 'system' ? getSystemTheme() : pref
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

let currentPreference: ThemePreference = typeof window === 'undefined' ? 'system' : getInitialPreference()
let currentTheme: Theme = typeof window === 'undefined' ? 'light' : resolve(currentPreference)
if (typeof window !== 'undefined') applyTheme(currentTheme)

const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

if (typeof window !== 'undefined') {
  // Only matters while the preference is 'system' — a direct light/dark
  // choice is never re-derived from the OS after the fact.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentPreference !== 'system') return
    currentTheme = getSystemTheme()
    applyTheme(currentTheme)
    listeners.forEach((cb) => { cb() })
  })
}

export function setTheme(preference: ThemePreference) {
  currentPreference = preference
  localStorage.setItem('theme', preference)
  currentTheme = resolve(preference)
  applyTheme(currentTheme)
  listeners.forEach((cb) => { cb() })
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => currentTheme, () => currentTheme)
  const preference = useSyncExternalStore(subscribe, () => currentPreference, () => currentPreference)
  return { theme, preference, setTheme }
}
