import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { db } from '../db/index.js'
import { flightDeckItems, flightDeckItemTranslations, flightDeckCompletions, users } from '../../../drizzle/schema.js'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

export const flightDeckRouter = Router()

flightDeckRouter.use(requireAuth)

// GET /api/flight-deck?locale=xx
//
// Returns the current user's own team's active checklist items — scoped via
// users.defaultTeamId, the same "which team am I" field themes.ts and the
// cost resolver already use for a contributor-facing, single-team lookup
// (this is NOT the leader-dashboard team switcher). Each item's
// label/tooltip is resolved to `locale` when a translation row exists,
// falling back to the base flight_deck_items text — same contract as
// nudge_rule_translations (see /api/nudges). Also returns showFlightDeck and
// a display name so the modal can render "Don't show again" state and the
// greeting without a second request.
flightDeckRouter.get('/', async (req, res) => {
  const userId = req.user!.id
  const q = req.query as Record<string, unknown>
  const locale = typeof q['locale'] === 'string' ? q['locale'].slice(0, 8) : null

  const [me] = await db
    .select({
      defaultTeamId: users.defaultTeamId,
      showFlightDeck: users.showFlightDeck,
      firstName: users.firstName,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!me) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }

  // No team yet (mid-provisioning) — nothing to show, but still report the
  // preference flag so the client doesn't have to special-case this.
  if (!me.defaultTeamId) {
    res.json({
      data: { items: [], showFlightDeck: me.showFlightDeck, firstName: me.firstName ?? me.displayName },
      error: null,
      meta: {},
    })
    return
  }

  const rows = await db
    .select()
    .from(flightDeckItems)
    .where(and(eq(flightDeckItems.teamId, me.defaultTeamId), eq(flightDeckItems.isActive, true)))
    .orderBy(flightDeckItems.sortOrder)

  const itemIds = rows.map((r) => r.id)

  const translations = itemIds.length > 0 && locale
    ? await db
        .select()
        .from(flightDeckItemTranslations)
        .where(and(inArray(flightDeckItemTranslations.itemId, itemIds), eq(flightDeckItemTranslations.locale, locale)))
    : []
  const translationByItem = new Map(translations.map((t) => [t.itemId, t]))

  const completions = itemIds.length > 0
    ? await db
        .select()
        .from(flightDeckCompletions)
        .where(and(eq(flightDeckCompletions.userId, userId), inArray(flightDeckCompletions.itemId, itemIds)))
    : []
  const completedIds = new Set(completions.map((c) => c.itemId))

  const items = rows.map((r) => {
    const translation = translationByItem.get(r.id)
    return {
      id: r.id,
      label: translation?.label ?? r.label,
      tooltip: translation?.tooltip ?? r.tooltip ?? null,
      icon: r.icon,
      iconColor: r.iconColor,
      screenshots: r.screenshots ?? [],
      linkType: r.linkType,
      linkValue: r.linkValue,
      sortOrder: r.sortOrder,
      completed: completedIds.has(r.id),
    }
  })

  res.json({
    data: { items, showFlightDeck: me.showFlightDeck, firstName: me.firstName ?? me.displayName },
    error: null,
    meta: {},
  })
})

// PATCH /api/flight-deck/items/:itemId/complete — per-user completion
// toggle. Upserts/deletes the flight_deck_completions row only; never
// touches flight_deck_items, so an admin's item config is unaffected by
// individual users checking things off.
flightDeckRouter.patch('/items/:itemId/complete', async (req, res) => {
  const userId = req.user!.id
  const { itemId } = req.params as { itemId: string }
  const schema = z.object({ completed: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  if (parsed.data.completed) {
    await db.insert(flightDeckCompletions).values({ userId, itemId }).onConflictDoNothing()
  } else {
    await db
      .delete(flightDeckCompletions)
      .where(and(eq(flightDeckCompletions.userId, userId), eq(flightDeckCompletions.itemId, itemId)))
  }
  res.json({ data: { itemId, completed: parsed.data.completed }, error: null, meta: {} })
})

// PATCH /api/flight-deck/preference — the single boolean behind both the
// modal's "Don't show again" checkbox and the matching My Settings toggle.
flightDeckRouter.patch('/preference', async (req, res) => {
  const schema = z.object({ show: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db.update(users).set({ showFlightDeck: parsed.data.show, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { show: parsed.data.show }, error: null, meta: {} })
})
