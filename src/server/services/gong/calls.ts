import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { gongCalls, systemSettings } from '../../../../drizzle/schema.js'
import { GONG_INDEX_LOOKBACK_DAYS, type GongParty } from '../../../shared/gong.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { GongError, gongListAll, gongRequest } from './client.js'
import { getGongConfig } from './config.js'
import { notDemoGongCall } from './demo.js'

// The Gong call index (Gong plan, phase 2). gong_call_index reads call
// metadata (parties, CRM context, calendar event id) from
// POST /v2/calls/extensive into gong_calls, so suggestions and search run
// against Postgres and opening the Transcripts tab costs no Gong request.
// Transcript text is never stored here.

const STATE_KEY = 'gong_call_index_state'
const DAY_MS = 24 * 60 * 60 * 1000
// Gong makes a call available some time after it ends, so every pass
// re-reads the last day as well as anything new.
const OVERLAP_MS = DAY_MS
// The first pass walks the lookback window in slices this long, one slice
// per tick, so a large tenant doesn't use its daily allowance in one go.
const SLICE_MS = 30 * DAY_MS
const MAX_PAGES_PER_SLICE = 100

export interface GongCallRow {
  id: string
  workspaceId: string | null
  title: string | null
  url: string | null
  scheduledAt: Date | null
  startedAt: Date
  durationS: number | null
  scope: string | null
  isPrivate: boolean
  calendarEventId: string | null
  primaryUserId: string | null
  parties: GongParty[]
  partyEmails: string[]
  partyUserIds: string[]
  crmObjects: Array<{ system: string | null; objectType: string | null; objectId: string }>
  crmObjectIds: string[]
}

function str(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function date(v: unknown): Date | null {
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function affiliation(v: unknown): GongParty['affiliation'] {
  const s = typeof v === 'string' ? v.toLowerCase() : ''
  return s === 'internal' ? 'internal' : s === 'external' ? 'external' : 'unknown'
}

// One call from /v2/calls/extensive. Null without an id or a start time.
export function toGongCallRow(raw: unknown): GongCallRow | null {
  const c = rec(raw)
  if (!c) return null
  const meta = rec(c['metaData']) ?? {}
  const id = str(meta['id'])
  const startedAt = date(meta['started']) ?? date(meta['scheduled'])
  if (!id || !startedAt) return null

  const parties: GongParty[] = []
  for (const p of Array.isArray(c['parties']) ? c['parties'] : []) {
    const r = rec(p)
    if (!r) continue
    parties.push({
      name: str(r['name']),
      email: str(r['emailAddress'])?.toLowerCase() ?? null,
      title: str(r['title']),
      affiliation: affiliation(r['affiliation']),
      speakerId: str(r['speakerId']),
      gongUserId: str(r['userId']),
    })
  }

  const crmObjects: GongCallRow['crmObjects'] = []
  for (const ctx of Array.isArray(c['context']) ? c['context'] : []) {
    const r = rec(ctx)
    if (!r) continue
    const system = str(r['system'])
    for (const o of Array.isArray(r['objects']) ? r['objects'] : []) {
      const obj = rec(o)
      const objectId = obj ? str(obj['objectId']) : null
      if (!obj || !objectId) continue
      crmObjects.push({ system, objectType: str(obj['objectType']), objectId })
    }
  }

  const duration = Number(meta['duration'])
  return {
    id,
    workspaceId: str(meta['workspaceId']),
    title: str(meta['title']),
    url: str(meta['url']),
    scheduledAt: date(meta['scheduled']),
    startedAt,
    durationS: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
    scope: str(meta['scope']),
    isPrivate: meta['isPrivate'] === true,
    calendarEventId: str(meta['calendarEventId']),
    primaryUserId: str(meta['primaryUserId']),
    parties,
    partyEmails: [...new Set(parties.map((p) => p.email).filter((e): e is string => !!e))],
    partyUserIds: [...new Set(parties.map((p) => p.gongUserId).filter((u): u is string => !!u))],
    crmObjects,
    crmObjectIds: [...new Set(crmObjects.map((o) => o.objectId))],
  }
}

export function pickGongCalls(body: unknown): GongCallRow[] {
  const b = rec(body)
  const list = b ? b['calls'] : null
  if (!Array.isArray(list)) return []
  return list.map(toGongCallRow).filter((c): c is GongCallRow => c !== null)
}

interface IndexState {
  // Everything that started before this instant has been read once.
  indexedTo: string | null
  // Where the first pass has reached, walking back from its start.
  backfilledFrom: string | null
  backfillDone: boolean
}

async function loadState(): Promise<IndexState> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, STATE_KEY)).limit(1)
  const v = (row?.value ?? {}) as Record<string, unknown>
  return {
    indexedTo: typeof v['indexedTo'] === 'string' ? v['indexedTo'] : null,
    backfilledFrom: typeof v['backfilledFrom'] === 'string' ? v['backfilledFrom'] : null,
    backfillDone: v['backfillDone'] === true,
  }
}

async function saveState(state: IndexState): Promise<void> {
  await db.insert(systemSettings).values({ key: STATE_KEY, value: state })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: state, updatedAt: new Date() } })
}

// On disconnect. Demo calls stay until Remove Demo Data.
export async function clearGongCallIndex(): Promise<void> {
  await db.delete(gongCalls).where(notDemoGongCall(gongCalls.id))
  await db.delete(systemSettings).where(eq(systemSettings.key, STATE_KEY))
}

// What one tick reads: the recent window (from the last pass, less the
// overlap, to now), plus one older slice while the first backfill runs.
export function planIndexWindows(state: IndexState, now: number): Array<{ from: number; to: number; kind: 'recent' | 'backfill' }> {
  const out: Array<{ from: number; to: number; kind: 'recent' | 'backfill' }> = []
  const floor = now - GONG_INDEX_LOOKBACK_DAYS * DAY_MS
  const indexedTo = state.indexedTo ? Date.parse(state.indexedTo) : NaN
  const recentFrom = Number.isFinite(indexedTo) ? Math.max(floor, indexedTo - OVERLAP_MS) : now - SLICE_MS
  out.push({ from: recentFrom, to: now, kind: 'recent' })
  if (!state.backfillDone) {
    const backFrom = state.backfilledFrom ? Date.parse(state.backfilledFrom) : recentFrom
    if (Number.isFinite(backFrom) && backFrom > floor) {
      out.push({ from: Math.max(floor, backFrom - SLICE_MS), to: backFrom, kind: 'backfill' })
    }
  }
  return out
}

async function upsertCalls(rows: GongCallRow[]): Promise<void> {
  const now = new Date()
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => ({ ...r, indexedAt: now }))
    await db.insert(gongCalls).values(chunk).onConflictDoUpdate({
      target: gongCalls.id,
      set: {
        workspaceId: sql`excluded.workspace_id`,
        title: sql`excluded.title`,
        url: sql`excluded.url`,
        scheduledAt: sql`excluded.scheduled_at`,
        startedAt: sql`excluded.started_at`,
        durationS: sql`excluded.duration_s`,
        scope: sql`excluded.scope`,
        isPrivate: sql`excluded.is_private`,
        calendarEventId: sql`excluded.calendar_event_id`,
        primaryUserId: sql`excluded.primary_user_id`,
        parties: sql`excluded.parties`,
        partyEmails: sql`excluded.party_emails`,
        partyUserIds: sql`excluded.party_user_ids`,
        crmObjects: sql`excluded.crm_objects`,
        crmObjectIds: sql`excluded.crm_object_ids`,
        indexedAt: now,
      },
    })
  }
}

async function readWindow(from: number, to: number, workspaceIds: string[]): Promise<GongCallRow[]> {
  const out: GongCallRow[] = []
  // Gong's filter takes one workspace; no selection means every workspace.
  for (const workspaceId of workspaceIds.length > 0 ? workspaceIds : [null]) {
    const filter: Record<string, unknown> = { fromDateTime: new Date(from).toISOString(), toDateTime: new Date(to).toISOString() }
    if (workspaceId) filter['workspaceId'] = workspaceId
    const rows = await gongListAll('/v2/calls/extensive', pickGongCalls, {
      method: 'POST',
      body: { filter, contentSelector: { context: 'Extended', exposedFields: { parties: true } } },
      maxPages: MAX_PAGES_PER_SLICE,
      // Gong answers 404 when no call matches the filter.
      allowStatuses: [404],
    })
    out.push(...rows)
  }
  return out
}

// Reads the given calls from Gong and adds them to the index (the webhook
// path). Calls in a workspace the admin didn't select are left out. Returns
// the ids that were indexed.
export async function indexGongCallsById(callIds: string[]): Promise<string[]> {
  if (callIds.length === 0) return []
  const cfg = await getGongConfig()
  if (!cfg) throw new GongError('errors.gong.not_configured')
  const res = await gongRequest('/v2/calls/extensive', {
    method: 'POST',
    body: { filter: { callIds }, contentSelector: { context: 'Extended', exposedFields: { parties: true } } },
    allowStatuses: [404],
  })
  const rows = pickGongCalls(res.body).filter((r) =>
    callIds.includes(r.id) && (cfg.workspaceIds.length === 0 || (r.workspaceId !== null && cfg.workspaceIds.includes(r.workspaceId))))
  await upsertCalls(rows)
  return rows.map((r) => r.id)
}

export interface GongCallIndexResult {
  calls: number
  backfillDone: boolean
  removed: number
}

// One pass of the index. Calls older than the lookback window are dropped;
// activity links keep their own snapshot.
export async function indexGongCalls(now: number = Date.now()): Promise<GongCallIndexResult> {
  const cfg = await getGongConfig()
  if (!cfg) throw new GongError('errors.gong.not_configured')
  const state = await loadState()
  let calls = 0
  const next: IndexState = { ...state }
  for (const w of planIndexWindows(state, now)) {
    const rows = await readWindow(w.from, w.to, cfg.workspaceIds)
    await upsertCalls(rows)
    calls += rows.length
    if (w.kind === 'recent') {
      next.indexedTo = new Date(w.to).toISOString()
      if (!next.backfilledFrom) next.backfilledFrom = new Date(w.from).toISOString()
    } else {
      next.backfilledFrom = new Date(w.from).toISOString()
      if (w.from <= now - GONG_INDEX_LOOKBACK_DAYS * DAY_MS) next.backfillDone = true
    }
  }
  if (!next.backfillDone && next.backfilledFrom && Date.parse(next.backfilledFrom) <= now - GONG_INDEX_LOOKBACK_DAYS * DAY_MS) next.backfillDone = true
  const removed = (await db.delete(gongCalls).where(and(lt(gongCalls.startedAt, new Date(now - GONG_INDEX_LOOKBACK_DAYS * DAY_MS)), notDemoGongCall(gongCalls.id))).returning({ id: gongCalls.id })).length
  await saveState(next)
  return { calls, backfillDone: next.backfillDone, removed }
}

export async function runGongCallIndex(opts: { source?: 'scheduled' | 'manual' } = {}): Promise<GongCallIndexResult | null> {
  if (!(await getGongConfig())) return null
  const startedAt = new Date()
  try {
    const result = await indexGongCalls()
    // A quiet pass (nothing new, backfill finished) records no run row, the
    // same rule as the other fast pollers.
    if (result.calls > 0 || result.removed > 0 || opts.source === 'manual') {
      await writeRun('gong_call_index', startedAt, 'ok', `${result.calls} calls read`, { ...result, source: opts.source ?? 'scheduled' })
    }
    return result
  } catch (err) {
    const code = err instanceof GongError ? err.code : err instanceof Error ? err.message : String(err)
    await writeRun('gong_call_index', startedAt, 'error', code, { source: opts.source ?? 'scheduled' })
    throw err
  }
}

let stopFn: (() => void) | null = null
export function startGongCallIndexWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob('gong_call_index', 15 * 60 * 1000, async () => {
    await runGongCallIndex().catch(() => {})
  }, { firstRunDelayMs: 5 * 60 * 1000 })
}
