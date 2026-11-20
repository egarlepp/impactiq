import type { Response } from 'express'
import { db } from '../../db/index.js'
import { appThemes } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'

// v1.106.0: decode a stored data URI (image/png, image/jpeg, image/svg+xml)
// into raw bytes + content type. Returns null when the input isn't a
// data URI (already an https:// URL, or empty).
//
// v1.289.0: security audit finding C2 — re-validates contentType against
// the same allowlist admin.ts's validateLogoDataUrl now enforces at upload
// time, as defense in depth for any row stored before that allowlist
// existed. Without this, this route served the stored MIME verbatim as the
// live Content-Type of an UNAUTHENTICATED response — a data:text/html;...
// value (nothing previously stopped one from being saved) would have been a
// same-origin stored-XSS primitive.
const ALLOWED_LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/bmp', 'image/x-ms-bmp'])
function decodeDataUri(input: string | null): { contentType: string; bytes: Buffer } | null {
  if (!input) return null
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(input.trim())
  if (!m || !m[1] || !ALLOWED_LOGO_MIME.has(m[1]) || !m[2]) return null
  return { contentType: m[1], bytes: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') }
}

// Serve the theme's uploaded logo (light or dark) as real image bytes
// over HTTP. Used in outbound emails so Outlook Windows fetches the
// image from the app URL like it does for CriteriaIQ / n8n templates,
// instead of choking on inline data URIs or CID attachments.
export async function serveThemeLogo(themeId: string, variant: 'light' | 'dark', res: Response): Promise<void> {
  const [row] = await db.select().from(appThemes).where(eq(appThemes.id, themeId)).limit(1)
  const stored = (variant === 'dark' ? row?.logoDark : row?.logoLight) ?? null
  const decoded = decodeDataUri(stored)
  if (!decoded) {
    res.status(404).type('image/png').end()
    return
  }
  res.setHeader('Content-Type', decoded.contentType)
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
  res.setHeader('Content-Length', String(decoded.bytes.length))
  // Belt-and-suspenders for the image/svg+xml case: SVG can embed <script>,
  // and unlike an <img>-embedded SVG, a direct navigation to this
  // unauthenticated URL renders it as a top-level document where that
  // script WOULD execute same-origin. `sandbox` disables script execution
  // (and navigation/forms) regardless of content; nosniff stops a browser
  // from ever reinterpreting the bytes as something else.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(decoded.bytes)
}
