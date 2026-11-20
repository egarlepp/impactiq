import { Router } from 'express'
import { db } from '../../db/index.js'
import { and, eq, sql } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'

export const historicalImportRoutes = Router()

// ─── v1.214.0: Historical Salesforce Event import ───────────────────────
// Admin-triggered, resumable backfill of pre-ImpactIQ Salesforce activity.
// App Admin only — this hits the org-wide admin SF connection and writes
// tens of thousands of rows.
historicalImportRoutes.get('/historical-import/status', requireAppAdmin, async (_req, res) => {
  const { getBackfillStatus, getRecentImportRuns, isBackfillRunning } = await import(
    '../../services/salesforce/historical/backfill.js'
  )
  const { listUnmappedTypes } = await import('../../services/salesforce/historical/relink.js')
  const { listExclusions, listTopCreators, countUnpurged } = await import(
    '../../services/salesforce/historical/exclusions.js'
  )
  const { getHistoricalAllDayCapHours, isHistoricalRecomputeNeeded, getHistoricalImportWindow } = await import(
    '../../services/config/integrations.js'
  )
  const { crmHistoricalEvents } = await import('../../../../drizzle/schema.js')
  const [state, runs, unmappedTypes, exclusions, topCreators, unpurged, allDayCapHours, recomputeNeeded, rowCountRes, window] =
    await Promise.all([
      getBackfillStatus(),
      getRecentImportRuns(10),
      listUnmappedTypes(50),
      listExclusions(),
      listTopCreators(20),
      countUnpurged(),
      getHistoricalAllDayCapHours(),
      isHistoricalRecomputeNeeded(),
      db.select({ c: sql<number>`count(*)::int` }).from(crmHistoricalEvents),
      getHistoricalImportWindow(),
    ])
  res.json({
    data: {
      state,
      runs,
      unmappedTypes,
      exclusions,
      topCreators,
      settings: {
        allDayCapHours,
        lookbackDays: window.lookbackDays,
        earliestDate: window.earliestDate,
        // The floor the next Reset cursor would use, so the admin can see the
        // effect of a saved change before committing to a re-walk.
        effectiveFloorAt: window.floorAt.toISOString(),
        // True when a fixed date has aged past the 3-year cap and is being
        // pulled forward. Silently honouring it would widen the measured scope.
        earliestDateClamped: window.clamped,
      },
      // Rows currently stored, as distinct from state.totalEventsImported,
      // which is a cumulative work counter that purge doesn't decrement.
      rowCount: rowCountRes[0]?.c ?? 0,
      // Rows an active rule matches but that were never purged. The read path
      // deliberately ignores exclusions, so surfacing this is what stops an
      // add-without-purge from rotting silently.
      unpurgedMatches: unpurged,
      recomputeNeeded,
    },
    error: null,
    meta: { walkerRunning: isBackfillRunning() },
  })
})

// ─── Exclusion rules ────────────────────────────────────────────────────
// Two independent lists: exclude Events by who CREATED them in Salesforce
// (the Outreach case — an integration creates records and assigns them to
// human owners) and, separately, by who OWNS them.
historicalImportRoutes.post('/historical-import/exclusions', requireAppAdmin, async (req, res) => {
  const { isExclusionKind, SF_USER_ID_RX, countMatchingEvents } = await import(
    '../../services/salesforce/historical/exclusions.js'
  )
  const { crmHistoricalExclusions } = await import('../../../../drizzle/schema.js')
  const body = req.body as { kind?: unknown; crmUserId?: unknown; label?: unknown; note?: unknown }
  const kind = body.kind
  const crmUserId = typeof body.crmUserId === 'string' ? body.crmUserId.trim() : ''
  if (!isExclusionKind(kind)) {
    res.status(400).json({ data: null, error: 'errors.historical.invalid_kind', meta: {} })
    return
  }
  // HubSpot installs name owners, HubSpot users and integration sources
  // instead of Salesforce User Ids (v1.401.0).
  const { getCrmProviderId } = await import('../../services/crm/providerSetting.js')
  const { HUBSPOT_HISTORICAL_ACTOR_RX } = await import('../../../shared/hubspot.js')
  const onHubspot = (await getCrmProviderId()) === 'hubspot'
  if (onHubspot ? !HUBSPOT_HISTORICAL_ACTOR_RX.test(crmUserId) : !SF_USER_ID_RX.test(crmUserId)) {
    res.status(400).json({ data: null, error: onHubspot ? 'errors.historical.invalid_hubspot_actor_id' : 'errors.historical.invalid_sf_user_id', meta: {} })
    return
  }
  const [existing] = await db
    .select()
    .from(crmHistoricalExclusions)
    .where(and(eq(crmHistoricalExclusions.kind, kind), eq(crmHistoricalExclusions.crmUserId, crmUserId)))
    .limit(1)
  if (existing) {
    res.status(409).json({ data: null, error: 'errors.historical.exclusion_exists', meta: {} })
    return
  }
  await db.insert(crmHistoricalExclusions).values({
    kind,
    crmUserId,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
    createdBy: req.user?.id ?? null,
  })
  // Report what a purge would remove; the delete itself is a separate,
  // explicitly confirmed call.
  const match = await countMatchingEvents(kind, crmUserId)
  await logAudit(req, {
    action: 'historical_import.exclusion_add',
    targetType: 'historical_exclusion',
    targetId: `${kind}:${crmUserId}`,
    meta: { matchedRows: match.matchedRows },
  })
  res.status(201).json({ data: { kind, crmUserId, ...match }, error: null, meta: {} })
})

historicalImportRoutes.patch('/historical-import/exclusions/:kind/:crmUserId', requireAppAdmin, async (req, res) => {
  const { isExclusionKind } = await import('../../services/salesforce/historical/exclusions.js')
  const { crmHistoricalExclusions } = await import('../../../../drizzle/schema.js')
  const { kind, crmUserId } = req.params as { kind: string; crmUserId: string }
  if (!isExclusionKind(kind)) {
    res.status(400).json({ data: null, error: 'errors.historical.invalid_kind', meta: {} })
    return
  }
  const body = req.body as { isActive?: unknown; label?: unknown; note?: unknown }
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (typeof body.isActive === 'boolean') patch['isActive'] = body.isActive
  if (typeof body.label === 'string') patch['label'] = body.label.trim() || null
  if (typeof body.note === 'string') patch['note'] = body.note.trim() || null
  await db
    .update(crmHistoricalExclusions)
    .set(patch)
    .where(and(eq(crmHistoricalExclusions.kind, kind), eq(crmHistoricalExclusions.crmUserId, crmUserId)))
  await logAudit(req, {
    action: 'historical_import.exclusion_update',
    targetType: 'historical_exclusion',
    targetId: `${kind}:${crmUserId}`,
    meta: patch as Record<string, unknown>,
  })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// Removes the RULE only. Imported rows are left alone — deleting them is the
// separate, explicitly confirmed purge below.
historicalImportRoutes.delete('/historical-import/exclusions/:kind/:crmUserId', requireAppAdmin, async (req, res) => {
  const { isExclusionKind } = await import('../../services/salesforce/historical/exclusions.js')
  const { crmHistoricalExclusions } = await import('../../../../drizzle/schema.js')
  const { kind, crmUserId } = req.params as { kind: string; crmUserId: string }
  if (!isExclusionKind(kind)) {
    res.status(400).json({ data: null, error: 'errors.historical.invalid_kind', meta: {} })
    return
  }
  await db
    .delete(crmHistoricalExclusions)
    .where(and(eq(crmHistoricalExclusions.kind, kind), eq(crmHistoricalExclusions.crmUserId, crmUserId)))
  await logAudit(req, {
    action: 'historical_import.exclusion_remove',
    targetType: 'historical_exclusion',
    targetId: `${kind}:${crmUserId}`,
  })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// Preview: how many imported rows this rule matches, without deleting.
historicalImportRoutes.get('/historical-import/exclusions/:kind/:crmUserId/preview', requireAppAdmin, async (req, res) => {
  const { isExclusionKind, countMatchingEvents } = await import(
    '../../services/salesforce/historical/exclusions.js'
  )
  const { kind, crmUserId } = req.params as { kind: string; crmUserId: string }
  if (!isExclusionKind(kind)) {
    res.status(400).json({ data: null, error: 'errors.historical.invalid_kind', meta: {} })
    return
  }
  res.json({ data: await countMatchingEvents(kind, crmUserId), error: null, meta: {} })
})

// Confirmed delete. `expectedCount` is what makes the confirmation meaningful:
// if a backfill ran between the preview and the confirm, the number the admin
// agreed to is stale, so re-prompt rather than deleting a different amount.
historicalImportRoutes.post('/historical-import/exclusions/:kind/:crmUserId/purge', requireAppAdmin, async (req, res) => {
  const { isExclusionKind, countMatchingEvents, purgeMatchingEvents } = await import(
    '../../services/salesforce/historical/exclusions.js'
  )
  const { kind, crmUserId } = req.params as { kind: string; crmUserId: string }
  if (!isExclusionKind(kind)) {
    res.status(400).json({ data: null, error: 'errors.historical.invalid_kind', meta: {} })
    return
  }
  const body = req.body as { confirm?: unknown; expectedCount?: unknown }
  if (body.confirm !== true) {
    res.status(400).json({ data: null, error: 'errors.historical.purge_not_confirmed', meta: {} })
    return
  }
  const live = await countMatchingEvents(kind, crmUserId)
  if (typeof body.expectedCount === 'number' && body.expectedCount !== live.matchedRows) {
    res.status(409).json({
      data: { matchedRows: live.matchedRows },
      error: 'errors.historical.purge_count_changed',
      meta: {},
    })
    return
  }
  const deleted = await purgeMatchingEvents(kind, crmUserId)
  await logAudit(req, {
    action: 'historical_import.exclusion_purge',
    targetType: 'historical_exclusion',
    targetId: `${kind}:${crmUserId}`,
    meta: { deleted },
  })
  res.json({ data: { deleted }, error: null, meta: {} })
})

// Estimate settings — currently just the all-day cap.
historicalImportRoutes.put('/historical-import/settings', requireAppAdmin, async (req, res) => {
  const {
    setHistoricalAllDayCapHours, getHistoricalAllDayCapHours,
    setHistoricalLookbackDays, setHistoricalEarliestDate, getHistoricalImportWindow,
    isHistoricalRecomputeNeeded, parseIsoDateUtc, historicalEarliestDateBounds,
    MIN_HIST_LOOKBACK_DAYS, MAX_HIST_LOOKBACK_DAYS,
  } = await import('../../services/config/integrations.js')
  const body = req.body as { allDayCapHours?: unknown; lookbackDays?: unknown; earliestDate?: unknown }

  // Every field is optional so the controls can save independently, but at
  // least one must be present — an empty PUT returning 200 would read as a
  // successful save that in fact changed nothing.
  let touched = false

  if (body.allDayCapHours !== undefined) {
    const raw = Number(body.allDayCapHours)
    if (!Number.isFinite(raw) || raw <= 0 || raw > 24) {
      res.status(400).json({ data: null, error: 'errors.historical.invalid_cap', meta: {} })
      return
    }
    await setHistoricalAllDayCapHours(raw)
    touched = true
  }

  if (body.lookbackDays !== undefined) {
    const raw = Number(body.lookbackDays)
    if (!Number.isFinite(raw) || raw < MIN_HIST_LOOKBACK_DAYS || raw > MAX_HIST_LOOKBACK_DAYS) {
      res.status(400).json({ data: null, error: 'errors.historical.invalid_lookback', meta: {} })
      return
    }
    await setHistoricalLookbackDays(raw)
    touched = true
  }

  // null clears the fixed date and hands control back to the relative window.
  // Validated against the same bounds the window uses, rather than clamped
  // silently — an admin who typed 2019 should be told, not quietly corrected.
  if (body.earliestDate !== undefined) {
    if (body.earliestDate === null || body.earliestDate === '') {
      await setHistoricalEarliestDate(null)
    } else {
      const raw = typeof body.earliestDate === 'string' ? body.earliestDate : ''
      const parsed = parseIsoDateUtc(raw)
      const { min, max } = historicalEarliestDateBounds()
      if (!parsed || parsed < min || parsed > max) {
        res.status(400).json({ data: null, error: 'errors.historical.invalid_earliest_date', meta: {} })
        return
      }
      await setHistoricalEarliestDate(raw)
    }
    touched = true
  }

  if (!touched) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }

  // A window change normally waits for Reset cursor, but there's nothing to
  // preserve on a backfill that has never run — apply it now so the page
  // doesn't keep showing the old "earliest" date as if the save had failed.
  const { applyWindowIfUntouched } = await import('../../services/salesforce/historical/backfill.js')
  const windowApplied = await applyWindowIfUntouched().catch(() => false)

  const [allDayCapHours, window, recomputeNeeded] = await Promise.all([
    getHistoricalAllDayCapHours(),
    getHistoricalImportWindow(),
    isHistoricalRecomputeNeeded(),
  ])
  await logAudit(req, {
    action: 'historical_import.settings_update',
    targetType: 'historical_import',
    targetId: 'settings',
    meta: { allDayCapHours, lookbackDays: window.lookbackDays, earliestDate: window.earliestDate, windowApplied },
  })
  // recomputeNeeded is read back rather than inferred from the request body:
  // the cap setter only raises the flag when the value actually moved, so a
  // window-only save must not report estimates as stale.
  res.json({
    data: {
      allDayCapHours,
      lookbackDays: window.lookbackDays,
      earliestDate: window.earliestDate,
      effectiveFloorAt: window.floorAt.toISOString(),
      earliestDateClamped: window.clamped,
    },
    error: null,
    meta: { recomputeNeeded, windowApplied },
  })
})

historicalImportRoutes.post('/historical-import/start', requireAppAdmin, async (req, res) => {
  const { startBackfill, dryRunBackfillSlice } = await import(
    '../../services/salesforce/historical/backfill.js'
  )
  // Dry run: fetch and resolve one slice, write nothing. Lets an admin check
  // user/type match rates before committing the full import.
  if (req.query['dryRun'] === 'true') {
    const out = await dryRunBackfillSlice()
    if ('error' in out) {
      res.status(400).json({ data: null, error: `errors.historical.${out.error}`, meta: {} })
      return
    }
    res.json({ data: out, error: null, meta: { dryRun: true } })
    return
  }
  const out = await startBackfill(req.user?.id ?? null)
  if ('error' in out) {
    res.status(409).json({ data: null, error: `errors.historical.${out.error}`, meta: {} })
    return
  }
  await logAudit(req, { action: 'historical_import.start', targetType: 'historical_import', targetId: 'events' })
  res.status(202).json({ data: out, error: null, meta: {} })
})

historicalImportRoutes.post('/historical-import/pause', requireAppAdmin, async (req, res) => {
  const { pauseBackfill } = await import('../../services/salesforce/historical/backfill.js')
  const state = await pauseBackfill()
  await logAudit(req, { action: 'historical_import.pause', targetType: 'historical_import', targetId: 'events' })
  res.json({ data: state, error: null, meta: {} })
})

historicalImportRoutes.post('/historical-import/resume', requireAppAdmin, async (req, res) => {
  const { startBackfill } = await import('../../services/salesforce/historical/backfill.js')
  const out = await startBackfill(req.user?.id ?? null)
  if ('error' in out) {
    res.status(409).json({ data: null, error: `errors.historical.${out.error}`, meta: {} })
    return
  }
  await logAudit(req, { action: 'historical_import.resume', targetType: 'historical_import', targetId: 'events' })
  res.status(202).json({ data: out, error: null, meta: {} })
})

// Rewinds the cursor to now(). Does NOT delete imported rows — a re-walk
// simply re-upserts them by SF Event Id.
historicalImportRoutes.post('/historical-import/reset', requireAppAdmin, async (req, res) => {
  const { resetBackfill, isBackfillRunning } = await import(
    '../../services/salesforce/historical/backfill.js'
  )
  if (isBackfillRunning()) {
    res.status(409).json({ data: null, error: 'errors.historical.already_running', meta: {} })
    return
  }
  const state = await resetBackfill()
  await logAudit(req, { action: 'historical_import.reset', targetType: 'historical_import', targetId: 'events' })
  res.json({ data: state, error: null, meta: {} })
})

// Re-resolves user / team / activity-type links from local tables only. Run
// after backfilling users.crm_user_id or editing the type map. No SF calls.
historicalImportRoutes.post('/historical-import/relink', requireAppAdmin, async (req, res) => {
  const { runHistoricalRelink } = await import('../../services/salesforce/historical/relink.js')
  const result = await runHistoricalRelink(req.user?.id ?? null)
  await logAudit(req, { action: 'historical_import.relink', targetType: 'historical_import', targetId: 'events', meta: { changed: result.changed } })
  res.json({ data: result, error: null, meta: {} })
})
