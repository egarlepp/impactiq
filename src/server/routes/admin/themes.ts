import { Router } from 'express'
import { db } from '../../db/index.js'
import { appThemes } from '../../../../drizzle/schema.js'
import { eq, sql } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { z } from 'zod'

export const themesAdminRoutes = Router()

// --- Themes ---
const themeColorsSchema = z.object({
  primaryLight: z.string(),
  primaryDark: z.string(),
  surfaceLight: z.string(),
  surfaceDark: z.string(),
  linkLight: z.string(),
  linkDark: z.string(),
  pageBgLight: z.string(),
  pageBgDark: z.string(),
  borderLight: z.string(),
  borderDark: z.string(),
  headerLightFrom: z.string(),
  headerLightTo: z.string(),
  headerDarkFrom: z.string(),
  headerDarkTo: z.string(),
  sidebarBgLight: z.string(),
  sidebarBgDark: z.string(),
  sidebarHighlightLight: z.string(),
  sidebarHighlightDark: z.string(),
  sidebarTextLight: z.string(),
  sidebarTextDark: z.string(),
  sidebarActiveTextLight: z.string(),
  sidebarActiveTextDark: z.string(),
  // Added in PR #62 — Zod strips unknown keys silently, so these have to be
  // declared explicitly or new sidebar color fields never persist.
  sidebarTextMutedLight: z.string().optional(),
  sidebarTextMutedDark: z.string().optional(),
  sidebarBorderLight: z.string().optional(),
  sidebarBorderDark: z.string().optional(),
  sidebarPillBgLight: z.string().optional(),
  sidebarPillBgDark: z.string().optional(),
  // Sidebar gradient stops (v1.34.6+). Optional so older themes without the
  // fields still validate; nav falls back to the solid sidebarBg* value.
  sidebarBgLightFrom: z.string().optional(),
  sidebarBgLightTo: z.string().optional(),
  sidebarBgDarkFrom: z.string().optional(),
  sidebarBgDarkTo: z.string().optional(),
  // v1.36 additions — .optional() so themes saved before this release
  // still validate on write.
  navHoverBgLight: z.string().optional(),
  navHoverBgDark: z.string().optional(),
  userPillNameLight: z.string().optional(),
  userPillNameDark: z.string().optional(),
  userPillSubtitleLight: z.string().optional(),
  userPillSubtitleDark: z.string().optional(),
  headerTextLight: z.string().optional(),
  headerTextDark: z.string().optional(),
  // v1.358.0 addition — sidebar "ImpactIQ" wordmark color. Same "must be
  // declared explicitly or it never persists" gotcha as every other
  // optional field above.
  appNameLight: z.string().optional(),
  appNameDark: z.string().optional(),
  pageHeaderIconLight: z.string().optional(),
  pageHeaderIconDark: z.string().optional(),
})

themesAdminRoutes.get('/themes', requireAppAdmin, async (_req, res) => {
  const rows = await db.select().from(appThemes).orderBy(appThemes.createdAt)
  res.json({ data: rows, error: null, meta: {} })
})

// v1.289.0: security audit finding C2 — shared with product icons below.
// logoLight/logoDark are later served back verbatim as the Content-Type of
// an UNAUTHENTICATED public route (services/email/logo.ts, GET
// /public/theme-logo/:themeId/:variant.png) so an outside recipient's email
// client can fetch them. Before this allowlist, validateLogoDataUrl accepted
// ANY data: URI — including e.g. data:text/html;base64,<script>… — which
// that route would then serve at a same-origin URL with Content-Type:
// text/html, a same-origin stored-XSS primitive. App-Admin-only reach today,
// but the allowlist plus logo.ts's own defense-in-depth (re-validated MIME +
// a locked-down CSP on that response) closes it regardless.
const IMAGE_DATA_URL_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/bmp', 'image/x-ms-bmp'])

const LOGO_MAX_BYTES = 4 * 1024 * 1024 // 4 MB decoded (client cap is 2 MB; extra headroom for encoding overhead)

export function validateLogoDataUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return null
  if (!value.startsWith('data:')) return null
  const match = /^data:([^;,]+)[;,]/.exec(value)
  if (!match || !IMAGE_DATA_URL_ALLOWED_MIME.has(match[1] ?? '')) return null
  // Rough size guard: base64 payload is ~4/3 of binary size
  const base64Part = value.split(',')[1] ?? ''
  const approxBytes = Math.floor(base64Part.length * 0.75)
  if (approxBytes > LOGO_MAX_BYTES) return null
  return value
}

// v1.93.0: 1MB cap for product icons per the user spec (PNG / SVG / BMP).
// Kept smaller than the theme-logo cap since product pills render at
// ~14px, so anything larger is pure DB bloat.
const PRODUCT_ICON_MAX_BYTES = 1 * 1024 * 1024
export function validateProductIconDataUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return null
  if (!value.startsWith('data:')) return null
  const match = /^data:([^;,]+)[;,]/.exec(value)
  if (!match || !IMAGE_DATA_URL_ALLOWED_MIME.has(match[1] ?? '')) return null
  const base64Part = value.split(',')[1] ?? ''
  const approxBytes = Math.floor(base64Part.length * 0.75)
  if (approxBytes > PRODUCT_ICON_MAX_BYTES) return null
  return value
}

themesAdminRoutes.post('/themes', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    colors: themeColorsSchema,
    logoLight: z.string().optional().nullable(),
    logoDark: z.string().optional().nullable(),
    emailTopBarColor: z.string().nullable().optional(),
    emailBottomBarColor: z.string().nullable().optional(),
    emailFooterLeftText: z.string().nullable().optional(),
    emailHeaderLogoVariant: z.enum(['light', 'dark']).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const logoLight = validateLogoDataUrl(parsed.data.logoLight)
  const logoDark = validateLogoDataUrl(parsed.data.logoDark)
  const [inserted] = await db
    .insert(appThemes)
    .values({
      name: parsed.data.name,
      colors: parsed.data.colors,
      logoLight,
      logoDark,
      emailTopBarColor: parsed.data.emailTopBarColor ?? null,
      emailBottomBarColor: parsed.data.emailBottomBarColor ?? null,
      emailFooterLeftText: parsed.data.emailFooterLeftText ?? null,
      emailHeaderLogoVariant: parsed.data.emailHeaderLogoVariant ?? null,
    })
    .returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

themesAdminRoutes.patch('/themes/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({
    name: z.string().min(1).optional(),
    colors: themeColorsSchema.optional(),
    isActive: z.boolean().optional(),
    logoLight: z.string().optional().nullable(),
    logoDark: z.string().optional().nullable(),
    // v1.85.0: email template overrides on the theme.
    emailTopBarColor: z.string().nullable().optional(),
    emailBottomBarColor: z.string().nullable().optional(),
    emailFooterLeftText: z.string().nullable().optional(),
    emailHeaderLogoVariant: z.enum(['light', 'dark']).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // vNext: the app guarantees exactly one Active theme at all times (there's
  // no separate org-wide "palette" fallback to fall back to anymore — see
  // CLAUDE.md §14). The only way to change which theme is active is to
  // activate a *different* one; explicitly deactivating the current one
  // with no replacement would leave the app with zero active themes.
  if (parsed.data.isActive === false) {
    res.status(400).json({ data: null, error: 'errors.themes.use_activate_another', meta: {} }); return
  }
  // Activating a theme deactivates all others — only one active theme at a time.
  if (parsed.data.isActive === true) {
    await db.update(appThemes).set({ isActive: false }).where(eq(appThemes.isActive, true))
  }
  const { logoLight: rawLight, logoDark: rawDark, ...rest } = parsed.data
  const updates: Record<string, unknown> = { ...rest }
  if (rawLight !== undefined) updates['logoLight'] = validateLogoDataUrl(rawLight)
  if (rawDark !== undefined) updates['logoDark'] = validateLogoDataUrl(rawDark)
  const [updated] = await db.update(appThemes).set(updates).where(eq(appThemes.id, id)).returning()
  res.json({ data: updated, error: null, meta: {} })
})

// POST /api/admin/themes/email-preview — render the sample email using
// either a live theme (id) or an ad-hoc set of fields the client just
// tweaked in the form. Returns { html, text } so the client can drop the
// HTML into an <iframe srcDoc> for a WYSIWYG preview.
themesAdminRoutes.post('/themes/email-preview', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    topBarColor: z.string().optional(),
    bottomBarColor: z.string().optional(),
    footerLeftText: z.string().nullable().optional(),
    logoUrl: z.string().nullable().optional(),
    // Optional overrides for sample content — defaults matter more than
    // form flexibility here.
    greetingName: z.string().optional(),
    subject: z.string().optional(),
    bodyHtml: z.string().optional(),
    bodyText: z.string().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  const { renderEmailTemplate, loadActiveThemeEmailConfig } = await import('../../services/email/template.js')
  const active = await loadActiveThemeEmailConfig()
  const cfg = {
    topBarColor: parsed.data.topBarColor ?? active.topBarColor,
    bottomBarColor: parsed.data.bottomBarColor ?? active.bottomBarColor,
    footerLeftText: parsed.data.footerLeftText === undefined ? active.footerLeftText : parsed.data.footerLeftText,
    logoUrl: parsed.data.logoUrl === undefined ? active.logoUrl : parsed.data.logoUrl,
    // v1.106.0: preview also shows the ImpactIQ mark on the left when
    // the hosted URL is configured (browsers fetch it from /public).
    hostedMarkUrl: active.hostedMarkUrl ?? null,
    // Preview intentionally does NOT use hostedLogoUrl — the iframe
    // renders the raw data URI so admins see their edits before saving.
    hostedLogoUrl: null as string | null,
  }
  const rendered = renderEmailTemplate({
    greetingName: parsed.data.greetingName ?? req.user?.displayName ?? 'Jane',
    subject: parsed.data.subject ?? 'ImpactIQ: sample notification',
    bodyHtml: parsed.data.bodyHtml ?? '<p style="margin:0 0 12px 0;">This is a preview of how notification emails will look with the current theme settings. The body text renders here, compact spacing between paragraphs.</p><p style="margin:0 0 12px 0;">Any HTML the sender includes will appear in this middle area.</p>',
    bodyText: parsed.data.bodyText ?? 'This is a preview of how notification emails will look with the current theme settings.',
  }, cfg, { mode: 'preview' })
  res.json({ data: rendered, error: null, meta: {} })
})

// POST /api/admin/themes/:id/clone — duplicate a theme (copies colors,
// logos, and email settings; the clone is inactive and gets a "(copy)"
// suffix so both rows are visible while admins tweak).
themesAdminRoutes.post('/themes/:id/clone', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const [src] = await db.select().from(appThemes).where(eq(appThemes.id, id)).limit(1)
  if (!src) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [created] = await db.insert(appThemes).values({
    name: `${src.name} (copy)`,
    colors: src.colors,
    isActive: false,
    logoLight: src.logoLight,
    logoDark: src.logoDark,
    emailTopBarColor: src.emailTopBarColor,
    emailBottomBarColor: src.emailBottomBarColor,
    emailFooterLeftText: src.emailFooterLeftText,
    emailHeaderLogoVariant: src.emailHeaderLogoVariant,
  }).returning()
  res.status(201).json({ data: created, error: null, meta: {} })
})

// vNext: guard the "always ≥1 theme, always exactly 1 active" invariant
// this app now relies on (no more org-wide palette fallback to fall back
// to — see CLAUDE.md §14). Deleting the last remaining theme, or the
// currently active one, would leave nothing for /api/themes/active (and
// therefore the login page + every team without its own override) to
// resolve to.
themesAdminRoutes.delete('/themes/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const [target] = await db.select().from(appThemes).where(eq(appThemes.id, id)).limit(1)
  if (!target) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [{ count } = { count: 0 }] = await db.select({ count: sql<number>`count(*)::int` }).from(appThemes)
  if (count <= 1) { res.status(400).json({ data: null, error: 'errors.themes.cannot_delete_last', meta: {} }); return }
  if (target.isActive) { res.status(400).json({ data: null, error: 'errors.themes.cannot_delete_active', meta: {} }); return }
  await db.delete(appThemes).where(eq(appThemes.id, id))
  res.json({ data: { id }, error: null, meta: {} })
})
