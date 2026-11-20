// Crops the empty border off a raster logo so the artwork itself fills the
// box it's displayed in. A logo exported from a design tool often carries
// a wide band of plain background (transparent, or a flat/gradient color)
// around the artwork; with object-fit: contain that band is scaled along
// with the artwork, so the visible logo ends up far smaller than the box.
//
// "Background" is estimated per pixel by bilinearly interpolating the four
// corner colors (alpha included), which covers transparent padding, a flat
// fill, and a linear gradient fill. Anything differing from that estimate by
// more than a tolerance counts as artwork. When that background is opaque
// it is also faded to transparent, so no rectangle shows behind the logo. Rows/columns need several such
// pixels before they count, so compression noise and stray specks don't
// stop the crop. SVGs are returned unchanged: they're usually drawn tight
// already, and rasterizing would lose sharpness when scaled up.
//
// Never throws: any failure resolves to the original data URL.

const ANALYSIS_MAX = 640
const COLOR_TOLERANCE = 40
const ALPHA_TOLERANCE = 40
const MATTE_LOW = 12
const MATTE_HIGH = 48

const cache = new Map<string, Promise<string>>()

export function trimImageDataUrl(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith('data:image/') || dataUrl.startsWith('data:image/svg')) return Promise.resolve(dataUrl)
  const hit = cache.get(dataUrl)
  if (hit) return hit
  const job = trim(dataUrl).catch(() => dataUrl)
  cache.set(dataUrl, job)
  return job
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('load failed'))
    img.src = src
  })
}

async function trim(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl)
  const fullW = img.naturalWidth
  const fullH = img.naturalHeight
  if (!fullW || !fullH) return dataUrl

  // Analyze a downscaled copy; map the bounding box back to full size.
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(fullW, fullH))
  const w = Math.max(1, Math.round(fullW * scale))
  const h = Math.max(1, Math.round(fullH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data

  const patch = Math.max(1, Math.round(Math.min(w, h) * 0.02))
  const corner = (x0: number, y0: number): number[] => {
    const sum = [0, 0, 0, 0]
    let n = 0
    for (let y = y0; y < y0 + patch; y++) {
      for (let x = x0; x < x0 + patch; x++) {
        const i = (y * w + x) * 4
        for (let c = 0; c < 4; c++) sum[c]! += px[i + c]!
        n++
      }
    }
    return sum.map((s) => s / n)
  }
  const tl = corner(0, 0)
  const tr = corner(w - patch, 0)
  const bl = corner(0, h - patch)
  const br = corner(w - patch, h - patch)

  const rowHits = new Uint32Array(h)
  const colHits = new Uint32Array(w)
  for (let y = 0; y < h; y++) {
    const fy = h > 1 ? y / (h - 1) : 0
    for (let x = 0; x < w; x++) {
      const fx = w > 1 ? x / (w - 1) : 0
      const i = (y * w + x) * 4
      const bg = (c: number) =>
        (tl[c]! * (1 - fx) + tr[c]! * fx) * (1 - fy) + (bl[c]! * (1 - fx) + br[c]! * fx) * fy
      const a = px[i + 3]!
      const bgA = bg(3)
      let content = Math.abs(a - bgA) > ALPHA_TOLERANCE
      // Color only matters where something is actually visible.
      if (!content && Math.max(a, bgA) > 24) {
        content =
          Math.abs(px[i]! - bg(0)) > COLOR_TOLERANCE ||
          Math.abs(px[i + 1]! - bg(1)) > COLOR_TOLERANCE ||
          Math.abs(px[i + 2]! - bg(2)) > COLOR_TOLERANCE
      }
      if (content) { rowHits[y]!++; colHits[x]!++ }
    }
  }

  const minRow = Math.max(2, Math.round(w * 0.004))
  const minCol = Math.max(2, Math.round(h * 0.004))
  let top = 0
  while (top < h && rowHits[top]! < minRow) top++
  if (top >= h) return dataUrl // nothing recognizable as artwork
  let bottom = h - 1
  while (bottom > top && rowHits[bottom]! < minRow) bottom--
  let left = 0
  while (left < w && colHits[left]! < minCol) left++
  let right = w - 1
  while (right > left && colHits[right]! < minCol) right--
  if (left >= right || top >= bottom) return dataUrl

  // Map back to full resolution and keep a small breathing margin.
  const margin = Math.round(Math.max(right - left, bottom - top) * 0.03)
  const sx = Math.max(0, Math.floor((left - margin) / scale))
  const sy = Math.max(0, Math.floor((top - margin) / scale))
  const ex = Math.min(fullW, Math.ceil((right + 1 + margin) / scale))
  const ey = Math.min(fullH, Math.ceil((bottom + 1 + margin) / scale))
  const cw = ex - sx
  const ch = ey - sy
  // Not worth re-encoding when there's hardly any border to remove.
  if (cw * ch > fullW * fullH * 0.92) return dataUrl

  const out = document.createElement('canvas')
  out.width = cw
  out.height = ch
  const octx = out.getContext('2d')
  if (!octx) return dataUrl
  octx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch)

  // An opaque background fill (flat or gradient) would still show as a
  // rectangle behind the artwork, since it never lines up exactly with the
  // page behind it. Fade it out with a soft matte against the same
  // corner-interpolated estimate; partially-different edge pixels keep
  // partial alpha so anti-aliasing stays smooth.
  if (Math.min(tl[3]!, tr[3]!, bl[3]!, br[3]!) > 200) {
    const data = octx.getImageData(0, 0, cw, ch)
    const d = data.data
    for (let y = 0; y < ch; y++) {
      const fy = fullH > 1 ? (sy + y) / (fullH - 1) : 0
      for (let x = 0; x < cw; x++) {
        const fx = fullW > 1 ? (sx + x) / (fullW - 1) : 0
        const i = (y * cw + x) * 4
        let diff = 0
        for (let c = 0; c < 3; c++) {
          const bg = (tl[c]! * (1 - fx) + tr[c]! * fx) * (1 - fy) + (bl[c]! * (1 - fx) + br[c]! * fx) * fy
          diff = Math.max(diff, Math.abs(d[i + c]! - bg))
        }
        const keep = Math.min(1, Math.max(0, (diff - MATTE_LOW) / (MATTE_HIGH - MATTE_LOW)))
        d[i + 3] = Math.round(d[i + 3]! * keep)
      }
    }
    octx.putImageData(data, 0, 0)
  }
  return out.toDataURL('image/png')
}
