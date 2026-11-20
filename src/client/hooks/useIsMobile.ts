import { useSyncExternalStore } from 'react'

// v1.419.0: true below Tailwind's `md` breakpoint (768px). The phone layout
// (sidebar as a slide-in drawer, Weekly View showing one pane at a time)
// switches on this rather than on CSS alone, because those screens render a
// different component tree on a phone, not just different classes.
const MOBILE_QUERY = '(max-width: 767px)'

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
