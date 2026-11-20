import { useSyncExternalStore } from 'react'

// v1.419.0: open/closed state of the sidebar drawer on a phone. The menu
// button lives in PageHeader (rendered per page) while the drawer is AppNav
// (mounted once in PageShell), so they share it through this tiny store, the
// same useSyncExternalStore pattern as store/flightDeck.ts.
let open = false
const listeners = new Set<() => void>()

function setOpen(next: boolean) {
  if (open === next) return
  open = next
  listeners.forEach((cb) => { cb() })
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function openMobileNav() { setOpen(true) }
export function closeMobileNav() { setOpen(false) }

export function useMobileNavOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => open)
}
