import { Router } from 'express'
import { db } from '../../db/index.js'
import { flightDeckItems, flightDeckItemTranslations } from '../../../../drizzle/schema.js'
import { and, eq, ne, sql } from 'drizzle-orm'
import { requireRole } from '../../middleware/rbac.js'
import { DEFAULT_FLIGHT_DECK_ITEMS } from '../../services/teams/defaults.js'
import { z } from 'zod'

export const flightDeckRoutes = Router()

// --- Flight Deck (Workplace jumpstart checklist) ---
// Team-scoped onboarding checklist shown in a login welcome modal — see
// GET /api/flight-deck in routes/auth.ts and CLAUDE.md §14 (Workplace
// admin category). teamId is a direct FK here (unlike keyword/nudge
// rules' many-to-many junction tables) since a checklist item only ever
// belongs to one team.
// v1.250.0: "up to 10 items" was the original spec, but the actual ask is
// "up to 10 ACTIVE at a time, add as many as you want" — an admin can build
// out a larger library and rotate which 10 are live. So there's no cap on
// total rows; FLIGHT_DECK_MAX_ACTIVE only gates transitions INTO isActive:true.
const FLIGHT_DECK_MAX_ACTIVE = 10
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
// Security fix (F-05, pentest 2026-09): linkValue/screenshots previously
// accepted any string with no scheme/format validation. Not currently
// exploitable — linkValue opens via window.open (a data:/javascript: URI
// just opens a blank tab) and screenshots render via <img src> (browsers
// don't execute a script embedded in an SVG loaded that way) — but a
// missing-validation defect worth closing as defense in depth per the
// report's own recommendation.
const FLIGHT_DECK_SCREENSHOT_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/bmp', 'image/x-ms-bmp'])
function isValidScreenshotDataUrl(value: string): boolean {
  const match = /^data:([^;,]+)[;,]/.exec(value)
  return !!match && FLIGHT_DECK_SCREENSHOT_ALLOWED_MIME.has(match[1] ?? '')
}
function isValidExternalLinkValue(value: string): boolean {
  return /^https?:\/\//i.test(value)
}
// app_page linkValue is a client-side react-router path — must be relative
// and in-app (leading "/", never "//" which a browser resolves as
// scheme-relative to a different host).
function isValidAppPageLinkValue(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//')
}
// Each data-URI screenshot is client-capped at 2MB binary (~2.7MB base64) —
// 4M chars here is a generous server-side backstop, not the real limit.
const screenshotsField = z.array(
  z.string().max(4_000_000).refine(isValidScreenshotDataUrl, { message: 'errors.flight_deck.invalid_screenshot' }),
).max(5)

async function countActiveFlightDeckItems(teamId: string, excludeId?: string) {
  const conditions = [eq(flightDeckItems.teamId, teamId), eq(flightDeckItems.isActive, true)]
  if (excludeId) conditions.push(ne(flightDeckItems.id, excludeId))
  const [{ count } = { count: 0 }] = await db.select({ count: sql<number>`count(*)::int` }).from(flightDeckItems).where(and(...conditions))
  return count
}

// screenshots is a nullable text[] column — any row inserted before this
// column existed (or never given screenshots) comes back from drizzle as
// `null`, not `[]`. The client types it as string[] and calls
// `.length`/`.map` on it unconditionally, so this normalization is load-
// bearing, not cosmetic (a raw null crashed the whole admin page).
function normalizeFlightDeckItem<T extends { screenshots: string[] | null }>(row: T): T & { screenshots: string[] } {
  return { ...row, screenshots: row.screenshots ?? [] }
}

flightDeckRoutes.get('/teams/:teamId/flight-deck-items', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db.select().from(flightDeckItems).where(eq(flightDeckItems.teamId, teamId)).orderBy(flightDeckItems.sortOrder)
  res.json({ data: rows.map(normalizeFlightDeckItem), error: null, meta: { maxActive: FLIGHT_DECK_MAX_ACTIVE } })
})

flightDeckRoutes.post('/teams/:teamId/flight-deck-items', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const user = req.user!
  const schema = z.object({
    label: z.string().min(1).max(120),
    tooltip: z.string().max(400).nullable().optional(),
    icon: z.string().min(1).max(64),
    iconColor: hexColor.nullable().optional(),
    screenshots: screenshotsField.optional(),
    linkType: z.enum(['app_page', 'external_url']),
    linkValue: z.string().min(1).max(500),
    isActive: z.boolean().default(true),
  }).refine(
    (data) => data.linkType === 'external_url' ? isValidExternalLinkValue(data.linkValue) : isValidAppPageLinkValue(data.linkValue),
    { message: 'errors.flight_deck.invalid_link_value', path: ['linkValue'] },
  )
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Never blocked on ADD — an item that would exceed the active cap is
  // simply created inactive instead, with the client told so it can toast.
  let cappedInactive = false
  let isActive = parsed.data.isActive
  if (isActive && (await countActiveFlightDeckItems(teamId)) >= FLIGHT_DECK_MAX_ACTIVE) {
    isActive = false
    cappedInactive = true
  }
  const [{ maxOrder } = { maxOrder: 0 }] = await db.select({ maxOrder: sql<number>`coalesce(max(${flightDeckItems.sortOrder}), 0)::int` }).from(flightDeckItems).where(eq(flightDeckItems.teamId, teamId))
  const [inserted] = await db.insert(flightDeckItems).values({
    teamId,
    ...parsed.data,
    isActive,
    isPreset: false,
    sortOrder: maxOrder + 1,
    createdBy: user.id,
  }).returning()
  res.status(201).json({ data: inserted && normalizeFlightDeckItem(inserted), error: null, meta: { cappedInactive, maxActive: FLIGHT_DECK_MAX_ACTIVE } })
})

flightDeckRoutes.patch('/teams/:teamId/flight-deck-items/:itemId', requireRole('admin'), async (req, res) => {
  const { teamId, itemId } = req.params as { teamId: string; itemId: string }
  const schema = z.object({
    label: z.string().min(1).max(120).optional(),
    tooltip: z.string().max(400).nullable().optional(),
    icon: z.string().min(1).max(64).optional(),
    iconColor: hexColor.nullable().optional(),
    screenshots: screenshotsField.optional(),
    linkType: z.enum(['app_page', 'external_url']).optional(),
    linkValue: z.string().min(1).max(500).optional(),
    isActive: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): scope to a row that actually
  // belongs to :teamId — requireRole('admin') only checks the caller's role
  // on the claimed team, not that this item is in it. flightDeckItems has a
  // direct teamId column (no junction, unlike keyword/nudge rules). Also
  // loads current linkType/linkValue for the F-05 effective-value check
  // below, since a PATCH can legally omit either one.
  const [ownedItem] = await db.select({ id: flightDeckItems.id, linkType: flightDeckItems.linkType, linkValue: flightDeckItems.linkValue })
    .from(flightDeckItems).where(and(eq(flightDeckItems.id, itemId), eq(flightDeckItems.teamId, teamId))).limit(1)
  if (!ownedItem) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  // Security fix (F-05, pentest 2026-09): validate against the EFFECTIVE
  // linkType/linkValue (patched value, or the existing one when a field is
  // omitted from this PATCH) — same "effective value" pattern already used
  // by the keyword-rules PATCH handler above for its action/type pair.
  const effectiveLinkType = parsed.data.linkType ?? ownedItem.linkType
  const effectiveLinkValue = parsed.data.linkValue ?? ownedItem.linkValue
  const linkValid = effectiveLinkType === 'external_url' ? isValidExternalLinkValue(effectiveLinkValue) : isValidAppPageLinkValue(effectiveLinkValue)
  if (!linkValid) { res.status(400).json({ data: null, error: 'errors.flight_deck.invalid_link_value', meta: {} }); return }
  // A PATCH that flips isActive false->true is the one transition that can
  // exceed the cap (edits to other fields, or turning something OFF, never
  // can) — block it with a clear error rather than silently overriding what
  // the admin explicitly asked for.
  if (parsed.data.isActive === true) {
    const activeCount = await countActiveFlightDeckItems(teamId, itemId)
    if (activeCount >= FLIGHT_DECK_MAX_ACTIVE) {
      res.status(400).json({ data: null, error: 'errors.flight_deck.max_active', meta: { max: FLIGHT_DECK_MAX_ACTIVE } })
      return
    }
  }
  const [updated] = await db.update(flightDeckItems).set({ ...parsed.data, updatedAt: new Date() }).where(and(eq(flightDeckItems.id, itemId), eq(flightDeckItems.teamId, teamId))).returning()
  if (!updated) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: normalizeFlightDeckItem(updated), error: null, meta: {} })
})

flightDeckRoutes.delete('/teams/:teamId/flight-deck-items/:itemId', requireRole('admin'), async (req, res) => {
  const { teamId, itemId } = req.params as { teamId: string; itemId: string }
  // Security fix (F-03, pentest 2026-09): see the PATCH handler above.
  const [deleted] = await db.delete(flightDeckItems).where(and(eq(flightDeckItems.id, itemId), eq(flightDeckItems.teamId, teamId))).returning()
  if (!deleted) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: { id: itemId }, error: null, meta: {} })
})

// Drag-reorder: client sends the full new id order for this team; sort_order
// is rewritten 1..N in a transaction. IDs that don't belong to this team are
// silently dropped rather than trusted blind, since this list comes from a
// client-held array, not a per-row team check. No total-items cap anymore,
// so the array can be arbitrarily long — 500 is just a sanity ceiling.
flightDeckRoutes.patch('/teams/:teamId/flight-deck-items/reorder', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({ orderedIds: z.array(z.string().uuid()).max(500) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const existing = await db.select({ id: flightDeckItems.id }).from(flightDeckItems).where(eq(flightDeckItems.teamId, teamId))
  const validIds = new Set(existing.map((r) => r.id))
  const toReorder = parsed.data.orderedIds.filter((id) => validIds.has(id))
  await db.transaction(async (tx) => {
    for (let i = 0; i < toReorder.length; i++) {
      await tx.update(flightDeckItems).set({ sortOrder: i + 1, updatedAt: new Date() }).where(eq(flightDeckItems.id, toReorder[i]!))
    }
  })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// v1.251.0: on-demand fix for a team that never got the seeded default
// checklist items — e.g. a team created before Flight Deck shipped, or one
// whose migration-time backfill (0125/0126) missed it because it already had
// at least one custom item when that migration ran. Inserts whichever of the
// canonical DEFAULT_FLIGHT_DECK_ITEMS aren't already present for this team
// (matched by exact label), so it's safe to click more than once — it only
// ever adds what's missing, never duplicates.
flightDeckRoutes.post('/teams/:teamId/flight-deck-items/seed-defaults', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const existing = await db.select({ label: flightDeckItems.label }).from(flightDeckItems).where(eq(flightDeckItems.teamId, teamId))
  const existingLabels = new Set(existing.map((r) => r.label))
  const missing = DEFAULT_FLIGHT_DECK_ITEMS.filter((d) => !existingLabels.has(d.label))
  if (missing.length === 0) {
    res.json({ data: { added: 0 }, error: null, meta: {} })
    return
  }
  const [{ maxOrder } = { maxOrder: 0 }] = await db.select({ maxOrder: sql<number>`coalesce(max(${flightDeckItems.sortOrder}), 0)::int` }).from(flightDeckItems).where(eq(flightDeckItems.teamId, teamId))
  let activeCount = await countActiveFlightDeckItems(teamId)
  const values = missing.map((d, i) => {
    const isActive = activeCount < FLIGHT_DECK_MAX_ACTIVE
    if (isActive) activeCount++
    return {
      teamId,
      label: d.label,
      tooltip: d.tooltip,
      icon: d.icon,
      linkType: d.linkType,
      linkValue: d.linkValue,
      isPreset: true,
      isActive,
      sortOrder: maxOrder + i + 1,
    }
  })
  await db.insert(flightDeckItems).values(values)
  res.json({ data: { added: missing.length }, error: null, meta: {} })
})

// Per-locale label/tooltip overrides — same shape and fallback contract as
// nudge_rule_translations above: admin picks a language, types the
// localized copy, and saves; when absent the viewer falls back to the
// item's base label/tooltip.
flightDeckRoutes.get('/teams/:teamId/flight-deck-items/:itemId/translations', requireRole('admin'), async (req, res) => {
  const { itemId } = req.params as { itemId: string }
  const rows = await db.select().from(flightDeckItemTranslations).where(eq(flightDeckItemTranslations.itemId, itemId))
  res.json({ data: rows, error: null, meta: {} })
})

flightDeckRoutes.put('/teams/:teamId/flight-deck-items/:itemId/translations/:locale', requireRole('admin'), async (req, res) => {
  const { teamId, itemId, locale } = req.params as { teamId: string; itemId: string; locale: string }
  const schema = z.object({ label: z.string().min(1).max(120), tooltip: z.string().max(400).nullable().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): verify the item this translation
  // belongs to is actually in :teamId before upserting.
  const [ownedItem] = await db.select({ id: flightDeckItems.id }).from(flightDeckItems).where(and(eq(flightDeckItems.id, itemId), eq(flightDeckItems.teamId, teamId))).limit(1)
  if (!ownedItem) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [existing] = await db.select().from(flightDeckItemTranslations)
    .where(and(eq(flightDeckItemTranslations.itemId, itemId), eq(flightDeckItemTranslations.locale, locale)))
    .limit(1)
  if (existing) {
    await db.update(flightDeckItemTranslations).set({ label: parsed.data.label, tooltip: parsed.data.tooltip ?? null, updatedAt: new Date() }).where(eq(flightDeckItemTranslations.id, existing.id))
  } else {
    await db.insert(flightDeckItemTranslations).values({ itemId, locale, label: parsed.data.label, tooltip: parsed.data.tooltip ?? null })
  }
  res.json({ data: { ok: true }, error: null, meta: {} })
})

flightDeckRoutes.delete('/teams/:teamId/flight-deck-items/:itemId/translations/:locale', requireRole('admin'), async (req, res) => {
  const { teamId, itemId, locale } = req.params as { teamId: string; itemId: string; locale: string }
  // Security fix (F-03, pentest 2026-09): see the PUT handler above.
  const [ownedItem] = await db.select({ id: flightDeckItems.id }).from(flightDeckItems).where(and(eq(flightDeckItems.id, itemId), eq(flightDeckItems.teamId, teamId))).limit(1)
  if (!ownedItem) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await db.delete(flightDeckItemTranslations)
    .where(and(eq(flightDeckItemTranslations.itemId, itemId), eq(flightDeckItemTranslations.locale, locale)))
  res.json({ data: { ok: true }, error: null, meta: {} })
})
