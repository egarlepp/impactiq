import { Router } from 'express'
import { db } from '../db/index.js'
import { appThemes, teams, users } from '../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { readSessionCookie, verifySession } from '../services/auth/session.js'

export const themesRouter = Router()

// vNext: the standalone org-brand-palette system_settings fallback this
// route used to blend in on top of the resolved theme is gone — the app
// now guarantees exactly one app_themes row is always Active (see
// CLAUDE.md §14, migration 0149), so a real Theme is always the single
// source of truth for colors/logos. No more "colors that came from
// nowhere" merge.
themesRouter.get('/active', async (req, res) => {
  // v1.88.0: pick the theme for the caller's default team first, then fall
  // back to the org-wide is_active theme. Silent no-op for pre-auth /login
  // hits — those still see is_active branding.
  let theme: typeof appThemes.$inferSelect | null = null
  try {
    const token = readSessionCookie(req)
    const session = token ? await verifySession(token) : null
    if (session) {
      const [u] = await db.select({ defaultTeamId: users.defaultTeamId }).from(users).where(eq(users.id, session.userId)).limit(1)
      if (u?.defaultTeamId) {
        const [tm] = await db.select({ activeThemeId: teams.activeThemeId }).from(teams).where(eq(teams.id, u.defaultTeamId)).limit(1)
        if (tm?.activeThemeId) {
          const [teamTheme] = await db.select().from(appThemes).where(eq(appThemes.id, tm.activeThemeId)).limit(1)
          if (teamTheme) theme = teamTheme
        }
      }
    }
  } catch { /* fall through to org-wide default */ }
  if (!theme) {
    const [row] = await db.select().from(appThemes).where(eq(appThemes.isActive, true)).limit(1)
    theme = row ?? null
  }
  res.json({
    data: theme
      ? { ...theme, logoLight: theme.logoLight ?? null, logoDark: theme.logoDark ?? null }
      : { logoLight: null, logoDark: null, colors: null },
    error: null,
    meta: {},
  })
})

// GET /api/themes — public list for admin pickers (Team Management theme
// selector). Just id + name; the full theme editor lives in the admin
// router. Requires session but no admin gate — team admins pick their
// team's theme from this list too.
themesRouter.get('/', async (req, res) => {
  const token = readSessionCookie(req)
  const session = token ? await verifySession(token) : null
  if (!session) { res.status(401).json({ data: null, error: 'Unauthorized', meta: {} }); return }
  const rows = await db.select({ id: appThemes.id, name: appThemes.name, isActive: appThemes.isActive }).from(appThemes).orderBy(appThemes.createdAt)
  res.json({ data: rows, error: null, meta: {} })
})

// GET /api/themes/support-email — the admin-configured support contact
// address, same genuinely-public shape as /active above: no session
// required, since the pre-auth Login/Setup/ForgotPassword/ResetPassword
// screens need this before any auth exists, and the in-app header help
// icon reads the identical endpoint post-login. Null/unset means "hide the
// icon" — there's no fallback address to guess at.
themesRouter.get('/support-email', async (_req, res) => {
  const { getSupportEmail } = await import('../services/config/integrations.js')
  res.json({ data: { email: await getSupportEmail() }, error: null, meta: {} })
})

// GET /api/themes/login-logo — the app-wide login screen logo (Admin →
// Themes → Login screen logo). Public for the same reason as
// /support-email: the pre-auth screens render it before any session
// exists. A null dataUrl means "use the active theme's logo instead";
// width/height are the admin's optional display-size overrides (px).
themesRouter.get('/login-logo', async (_req, res) => {
  const { getLoginLogoConfig } = await import('../services/config/integrations.js')
  res.json({ data: await getLoginLogoConfig(), error: null, meta: {} })
})
