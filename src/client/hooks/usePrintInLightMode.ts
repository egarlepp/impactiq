import { useEffect } from 'react'

// v1.420.0 (ported from VectorIQ): dark mode paints text near-white and
// browsers leave backgrounds out of a printout, so a page printed in dark mode
// comes out white on white. The theme is a class on <html> (store/theme.ts),
// so take it off for the print job and put it back afterwards.
export function usePrintInLightMode(): void {
  useEffect(() => {
    const root = document.documentElement
    let wasDark = false
    const before = () => {
      wasDark = root.classList.contains('dark')
      root.classList.remove('dark')
    }
    const after = () => {
      if (wasDark) root.classList.add('dark')
      wasDark = false
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
      after()
    }
  }, [])
}
