// Text color for a themed primary button. Buttons have always used white
// text, so white stays unless it falls below 2:1 contrast on the button color
// (e.g. the Gray or Dark preset's near-white dark-mode primary), in which case
// dark ink is used. The low 2:1 floor keeps every mid-tone theme looking exactly
// as it did and only changes buttons whose white text was nearly unreadable.
const HEX_RE = /^#[0-9a-fA-F]{6}$/
const LIGHT_INK = '#FFFFFF'
const DARK_INK = '#0F172A'

function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

const MIN_WHITE_CONTRAST = 2

export function readableTextOn(background: string): string | undefined {
  if (!HEX_RE.test(background)) return undefined
  const bg = relativeLuminance(background) + 0.05
  const onLight = (relativeLuminance(LIGHT_INK) + 0.05) / bg
  return onLight >= MIN_WHITE_CONTRAST ? LIGHT_INK : DARK_INK
}
