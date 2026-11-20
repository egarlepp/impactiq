// Login screen logo sizing (Admin → Themes → Login screen logo). The admin
// can set an explicit width and/or height in px; any dimension left unset
// falls back to a default chosen by the uploaded image's own shape: a
// roughly square image gets a 250×250 box, anything else (wide or tall) a
// 750×200 box. The box is a bounding box — the image is scaled to fit it
// with object-fit: contain, never stretched, and capped at 100% of the
// viewport width so it stays responsive on narrow screens.

export const LOGIN_LOGO_SIZE_MIN = 40
export const LOGIN_LOGO_SIZE_MAX = 2000

export const LOGIN_LOGO_DEFAULT_RECT = { width: 750, height: 200 } as const
export const LOGIN_LOGO_DEFAULT_SQUARE = { width: 250, height: 250 } as const

// Aspect ratios within this band (width ÷ height) count as "square", so a
// 512×480 mark isn't treated as a banner.
const SQUARE_MIN_RATIO = 0.85
const SQUARE_MAX_RATIO = 1.18

export function isSquareish(naturalWidth: number, naturalHeight: number): boolean {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return false
  const ratio = naturalWidth / naturalHeight
  return ratio >= SQUARE_MIN_RATIO && ratio <= SQUARE_MAX_RATIO
}

export function defaultLoginLogoSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  return isSquareish(naturalWidth, naturalHeight) ? { ...LOGIN_LOGO_DEFAULT_SQUARE } : { ...LOGIN_LOGO_DEFAULT_RECT }
}

export function resolveLoginLogoSize(
  natural: { width: number; height: number },
  configured: { width: number | null; height: number | null },
): { width: number; height: number } {
  const fallback = defaultLoginLogoSize(natural.width, natural.height)
  return {
    width: configured.width ?? fallback.width,
    height: configured.height ?? fallback.height,
  }
}

// Normalizes a stored/submitted dimension: a whole number of px within
// [MIN, MAX], or null for "use the default".
export function normalizeLoginLogoDimension(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(Math.min(Math.max(n, LOGIN_LOGO_SIZE_MIN), LOGIN_LOGO_SIZE_MAX))
}
