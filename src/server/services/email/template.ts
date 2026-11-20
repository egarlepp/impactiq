// v1.85.0: system-default email template + tenant-theme overrides.
//
// Every outbound email in the app funnels through renderEmailTemplate so the
// look is consistent (nudges, weekly recaps, admin test sends, password
// resets, everything). The template is deliberately email-client safe:
// inline styles, table-based layout at 960px wide, no CSS variables, no
// external assets other than the two logos.
//
// Theme fields (all optional, all on app_themes):
//   emailTopBarColor / emailBottomBarColor — bar backgrounds; default indigo
//   emailFooterLeftText                    — arbitrary string on footer left
//   emailHeaderLogoVariant                 — 'light' | 'dark'; picks which
//                                            of the theme's uploaded logos
//                                            is embedded on the right of the
//                                            header. Nulls → logoLight.
//
// The left of the header is ALWAYS the built-in ImpactIQ mark so recipients
// can identify the sending product regardless of tenant branding.

import { db } from '../../db/index.js'
import { appThemes } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'

export interface RenderEmailInput {
  greetingName: string   // "Eric" — rendered as "Hello Eric,"
  subject: string        // used for the <title> only; body must not repeat it
  bodyHtml: string       // caller-supplied HTML for the middle area
  bodyText: string       // caller-supplied plain-text mirror
}

export interface InlineAttachment {
  contentId: string        // referenced from HTML as `cid:contentId`
  filename: string
  contentType: string      // 'image/png', 'image/jpeg', 'image/gif'
  contentBase64: string    // raw base64, no data-URI prefix
}

export interface RenderedEmail {
  html: string
  text: string
  // v1.103.0: images referenced as CID inline attachments so Outlook
  // (Windows desktop) actually renders them. Outlook silently drops
  // inline data:image/* — hosted URLs are the fallback, CID is the
  // portable one that survives corporate mail policies.
  attachments: InlineAttachment[]
}

const DEFAULT_TOP_BAR = '#4f46e5'          // indigo-600
const DEFAULT_BOTTOM_BAR = '#111827'       // gray-900
const CONTENT_WIDTH = 960
const BAR_HEIGHT = 51
const IMPACTIQ_MARK_TEXT = 'ImpactIQ'

// v1.102.0: Outlook (Windows desktop) blocks data:image/svg+xml. The
// wordmark is now plain text on the tinted top bar so every client
// renders it identically. The tenant's uploaded PNG/JPEG logo still
// renders on the right of the header (via CID inline attachment in
// send mode, via the original data URI in preview mode).

// Pick a text color (near-white or near-black) that contrasts against the
// given background hex. Uses relative luminance per WCAG. Falls back to
// white when the input isn't parseable so we never render illegible text.
export function contrastText(bgHex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bgHex.trim())
  if (!m || !m[1]) return '#ffffff'
  const hex = m[1]
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.5 ? '#111827' : '#ffffff'
}

export interface ThemeEmailConfig {
  topBarColor: string
  bottomBarColor: string
  footerLeftText: string | null
  logoUrl: string | null
  // v1.106.0: when the send mode wants to render the tenant logo via
  // hosted URL instead of inline base64 / CID, callers set hostedLogoUrl
  // to the fully-qualified https URL and hostedMarkUrl to the ImpactIQ
  // mark URL. Both are optional; leave null to fall back to CID (send
  // mode) or the raw data URI (preview mode).
  hostedLogoUrl?: string | null
  hostedMarkUrl?: string | null
}

// v1.106.0: build the hosted image URLs from the app's public base URL
// + the active theme id. Returns null pieces when we can't resolve
// them (no base URL configured, or no theme with a logo). The renderer
// then falls back to CID / data URI paths.
async function buildHostedImageUrls(themeIdWithLogo: string | null, variant: 'light' | 'dark'): Promise<{ hostedLogoUrl: string | null; hostedMarkUrl: string | null }> {
  const { getPublicBaseUrl } = await import('../config/integrations.js')
  const base = await getPublicBaseUrl()
  if (!base) return { hostedLogoUrl: null, hostedMarkUrl: null }
  // v1.108.0: Outlook Windows doesn't reliably render SVG (it either
  // shows the alt text or partially renders individual <rect>/<line>
  // elements). Switched the mark to a hand-drawn PNG at /public/
  // impactiq-mark.png (rendered from the same design intent as the
  // sidebar SVG). Preview iframe + all mail clients render PNG.
  const hostedMarkUrl = `${base}/public/impactiq-mark.png`
  const hostedLogoUrl = themeIdWithLogo ? `${base}/public/theme-logo/${themeIdWithLogo}/${variant}.png` : null
  return { hostedLogoUrl, hostedMarkUrl }
}

// Load the active app theme's email settings. When no theme is active or
// the theme has no email overrides, returns the system default so emails
// still render (contract: renderer must never fail on missing config).
export async function loadActiveThemeEmailConfig(): Promise<ThemeEmailConfig> {
  // vNext: two-tier fallback — active theme's per-theme overrides, else
  // hardcoded system defaults (indigo/slate). The former third tier (the
  // org-wide "brand palette" system_settings singleton) is gone — the app
  // now guarantees exactly one app_themes row is always Active, so that row
  // is the single source of truth (CLAUDE.md §14, migration 0149).
  const [row] = await db.select().from(appThemes).where(eq(appThemes.isActive, true)).limit(1)
  const variantKey = row?.emailHeaderLogoVariant ?? 'light'
  const variantLogo = variantKey === 'dark' ? row?.logoDark : row?.logoLight
  const logoOwnerId = row && variantLogo ? row.id : null
  const hosted = await buildHostedImageUrls(logoOwnerId, variantKey === 'dark' ? 'dark' : 'light')
  return {
    topBarColor: row?.emailTopBarColor ?? DEFAULT_TOP_BAR,
    bottomBarColor: row?.emailBottomBarColor ?? DEFAULT_BOTTOM_BAR,
    footerLeftText: row?.emailFooterLeftText ?? null,
    logoUrl: variantLogo ?? row?.logoLight ?? null,
    hostedLogoUrl: hosted.hostedLogoUrl,
    hostedMarkUrl: hosted.hostedMarkUrl,
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ))
}

function todayIso(): string {
  // Passed timestamps aren't safe in workflows; here we're inside a live send,
  // so plain Date() is fine. Formatted YYYY-MM-DD for consistency across locales.
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// v1.103.0: convert a data:image/* URI to an inline CID attachment.
// Returns { cidRef, attachment } — the caller replaces the img src with
// `cid:${cidRef}` and appends the attachment to the message. Non-data
// URIs (already hosted URLs) return null so they're left as-is.
function dataUriToAttachment(dataUri: string, cid: string, filename: string): { cidRef: string; attachment: InlineAttachment } | null {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUri.trim())
  if (!m) return null
  const contentType = m[1] ?? 'application/octet-stream'
  const contentBase64 = (m[2] ?? '').replace(/\s+/g, '')
  return {
    cidRef: cid,
    attachment: { contentId: cid, filename, contentType, contentBase64 },
  }
}

export function renderEmailTemplate(input: RenderEmailInput, cfg: ThemeEmailConfig, opts: { mode?: 'send' | 'preview' } = {}): RenderedEmail {
  const mode = opts.mode ?? 'send'
  const topBg = cfg.topBarColor
  const bottomBg = cfg.bottomBarColor
  const topText = contrastText(topBg)
  const bottomText = contrastText(bottomBg)
  const footerLeft = cfg.footerLeftText ?? ''
  const footerRight = `Generated by ImpactIQ · ${todayIso()}`
  const attachments: InlineAttachment[] = []
  // Left side of the top bar: ImpactIQ mark (hosted PNG in send mode
  // when we have a public URL; falls back to text-only header).
  // v1.112.0: Outlook shows a "broken image" icon (a thin horizontal
  // dash) when the mark URL doesn't fetch (external-sender image
  // blocking, unreachable base URL, etc.). Wrap the img in a cell with
  // font-size:0 + line-height:0 + color:transparent so the alt text
  // renders invisible AND the broken-image glyph is suppressed by the
  // zero line-height. Users on trusted-sender orgs still see the real
  // logo; everyone else sees a clean text-only "ImpactIQ" wordmark.
  const markImg = cfg.hostedMarkUrl
    ? `<img src="${escapeHtml(cfg.hostedMarkUrl)}" alt="" width="24" height="24" style="display:block;border:0;outline:none;font-size:0;line-height:0;">`
    : ''
  // Right side of the top bar: tenant logo. Preference order:
  //  1. hostedLogoUrl (send mode, admin has set the public base URL)
  //  2. inline data URI (preview mode — iframe renders it)
  //  3. CID inline attachment (send mode fallback when no hosted URL)
  //  4. pass-through https URL (already hosted, e.g. via CDN)
  let logoImg = ''
  if (cfg.hostedLogoUrl && mode === 'send') {
    logoImg = `<img src="${escapeHtml(cfg.hostedLogoUrl)}" alt="" height="32" style="display:block;max-height:32px;">`
  } else if (cfg.logoUrl) {
    if (mode === 'preview') {
      logoImg = `<img src="${escapeHtml(cfg.logoUrl)}" alt="" height="32" style="display:block;max-height:32px;">`
    } else {
      const converted = dataUriToAttachment(cfg.logoUrl, 'tenant-logo', 'tenant-logo')
      if (converted) {
        attachments.push(converted.attachment)
        const ext = converted.attachment.contentType.split('/')[1] ?? 'png'
        converted.attachment.filename = `tenant-logo.${ext}`
        logoImg = `<img src="cid:${converted.cidRef}" alt="" height="32" style="display:block;max-height:32px;">`
      } else {
        logoImg = `<img src="${escapeHtml(cfg.logoUrl)}" alt="" height="32" style="display:block;max-height:32px;">`
      }
    }
  }

  // Table-based layout because Outlook still renders best with tables in
  // 2026. Inline styles everywhere — Gmail strips <style> blocks.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${CONTENT_WIDTH}px;max-width:100%;background:#ffffff;border-collapse:collapse;">
        <!-- Top bar -->
        <tr>
          <td style="background:${topBg};height:${BAR_HEIGHT}px;padding:0 20px;color:${topText};" height="${BAR_HEIGHT}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="height:${BAR_HEIGHT}px;">
              <tr>
                <td align="left" valign="middle" style="color:${topText};font-size:18px;font-weight:600;letter-spacing:0.2px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    ${markImg ? `<td valign="middle" width="24" style="width:24px;padding-right:8px;line-height:0;font-size:0;color:transparent;">${markImg}</td>` : ''}
                    <td valign="middle" style="color:${topText};font-size:18px;font-weight:600;letter-spacing:0.2px;text-decoration:none;line-height:24px;mso-line-height-rule:exactly;"><span style="color:${topText};text-decoration:none;">${escapeHtml(IMPACTIQ_MARK_TEXT)}</span></td>
                  </tr></table>
                </td>
                <td align="right" valign="middle">${logoImg}</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:20px 28px;color:#111827;font-size:14px;line-height:1.5;">
            ${input.bodyHtml}
          </td>
        </tr>
        <!-- Bottom bar -->
        <tr>
          <td style="background:${bottomBg};height:${BAR_HEIGHT}px;padding:0 20px;color:${bottomText};" height="${BAR_HEIGHT}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="height:${BAR_HEIGHT}px;">
              <tr>
                <td align="left" valign="middle" style="color:${bottomText};font-size:12px;">
                  ${escapeHtml(footerLeft)}
                </td>
                <td align="right" valign="middle" style="color:${bottomText};font-size:12px;">
                  ${escapeHtml(footerRight)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const text = [
    `${IMPACTIQ_MARK_TEXT}`,
    '',
    input.bodyText.trim(),
    '',
    '---',
    footerLeft ? footerLeft : '',
    footerRight,
  ].filter(Boolean).join('\n')

  return { html, text, attachments }
}

// Convenience wrapper: pulls the active theme's email config, then renders.
// Callers with no per-recipient theming (i.e. everyone right now) use this.
export async function renderWithActiveTheme(input: RenderEmailInput): Promise<RenderedEmail> {
  const cfg = await loadActiveThemeEmailConfig()
  return renderEmailTemplate(input, cfg)
}
