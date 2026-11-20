import { useSyncExternalStore } from 'react'

// Tiny pub/sub so the header button (rendered per-page, inside PageHeader)
// can re-open the Flight Deck modal (mounted once, at PageShell level) —
// same useSyncExternalStore pattern as store/theme.ts. Two pieces of state:
// whether the header button should render at all (mirrors the user's
// showFlightDeck flag once FlightDeckModal's initial fetch resolves it),
// and a request counter the modal watches to know "open me again".

let available = false
let openRequestId = 0

const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((cb) => { cb() })
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// Called by FlightDeckModal once it knows the user's current preference —
// disappears the moment showFlightDeck is turned off (My Settings or the
// modal's own "Don't show again"), reappears if turned back on.
export function setFlightDeckAvailable(next: boolean) {
  if (available === next) return
  available = next
  notify()
}

export function openFlightDeck() {
  openRequestId += 1
  notify()
}

export function useFlightDeckAvailable() {
  return useSyncExternalStore(subscribe, () => available, () => available)
}

export function useFlightDeckOpenRequest() {
  return useSyncExternalStore(subscribe, () => openRequestId, () => openRequestId)
}
