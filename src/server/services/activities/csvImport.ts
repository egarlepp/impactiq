import { db } from '../../db/index.js'
import { activities, teamActivityTypes, users, teamMembers } from '../../../../drizzle/schema.js'
import { and, eq, inArray } from 'drizzle-orm'

// Minimal CSV parser. Handles quoted fields with embedded commas and doubled
// quotes ("" → "). No streaming; the request-body size limit already caps
// input to ~256kb which is roughly 3-4k rows.
function parseCsv(text: string): string[][] {
  // The text comes from a request body; a non-string (an object with a huge
  // `length`) must never drive the loop below.
  if (typeof text !== 'string') throw new Error('CSV input must be a string')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += ch
      }
    } else {
      if (ch === ',') { row.push(field); field = '' }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (ch === '"' && field.length === 0) { inQuotes = true }
      else { field += ch }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}

export interface ImportRow {
  index: number
  raw: Record<string, string>
  errors: string[]
  // Populated when errors is empty
  activity?: {
    userId: string
    teamId: string
    activityTypeId: string
    title: string
    startDatetime: Date
    endDatetime: Date
    effortHours: string
    notes: string | null
    status: 'draft' | 'submitted'
  }
}

export interface ImportOptions {
  teamId: string
  defaultUserId: string
  // Whether the CSV may specify user_email per row (admin bulk import). When
  // false, every row is assigned to defaultUserId regardless of the column.
  allowUserEmailColumn: boolean
}

// Parse + validate an entire CSV in one pass. Returns per-row diagnostics
// AND a "ready-to-insert" activity payload for rows without errors. The
// caller decides whether to commit (submitFn) or bail on any error.
export async function planImport(csvText: string, opts: ImportOptions): Promise<{ rows: ImportRow[]; summary: { total: number; ready: number; errored: number } }> {
  const parsed = parseCsv(csvText)
  if (parsed.length === 0) return { rows: [], summary: { total: 0, ready: 0, errored: 0 } }
  const headerRaw = parsed[0]!
  const dataRows = parsed.slice(1)
  const headers = headerRaw.map((h) => h.trim().toLowerCase())
  const idx = (name: string) => headers.indexOf(name)
  const H = {
    date: idx('date'),
    time: idx('time'),
    duration: idx('duration_hours'),
    type: idx('activity_type'),
    title: idx('title'),
    notes: idx('notes'),
    userEmail: idx('user_email'),
    status: idx('status'),
  }
  if (H.date < 0 || H.type < 0 || H.title < 0 || H.duration < 0) {
    return {
      rows: [{ index: 0, raw: {}, errors: ['CSV header must include: date, activity_type, title, duration_hours (and optionally time, notes, status, user_email)'] }],
      summary: { total: dataRows.length, ready: 0, errored: dataRows.length },
    }
  }
  // Preload the team's active activity types (name → id) and, when the caller
  // allows user_email mapping, the user directory for the team.
  const typeRows = await db
    .select({ id: teamActivityTypes.id, name: teamActivityTypes.name })
    .from(teamActivityTypes)
    .where(and(eq(teamActivityTypes.teamId, opts.teamId), eq(teamActivityTypes.isActive, true)))
  const typeIdByName = new Map(typeRows.map((r) => [r.name.toLowerCase(), r.id] as const))

  let teamMemberEmailToId = new Map<string, string>()
  if (opts.allowUserEmailColumn) {
    const memberRows = await db
      .select({ userId: users.id, email: users.email })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, opts.teamId))
    teamMemberEmailToId = new Map(memberRows.map((r) => [r.email.toLowerCase(), r.userId] as const))
  }

  const outRows: ImportRow[] = []
  let ready = 0

  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r]!
    // Keys are the file's own header names, so build the row with own properties.
    const raw: Record<string, string> = Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]))
    const errors: string[] = []

    // Date + optional time
    const dateStr = raw['date'] ?? ''
    const timeStr = raw['time'] ?? '09:00'
    const dt = new Date(`${dateStr}T${timeStr.length === 5 ? `${timeStr}:00` : timeStr}Z`)
    if (Number.isNaN(dt.getTime())) errors.push(`Invalid date/time: "${dateStr}" "${timeStr}"`)

    // Duration
    const durationStr = raw['duration_hours'] ?? ''
    const duration = Number(durationStr)
    if (!Number.isFinite(duration) || duration <= 0 || duration > 24) errors.push(`Invalid duration_hours: "${durationStr}"`)

    // Type name → id
    const typeName = (raw['activity_type'] ?? '').toLowerCase()
    const activityTypeId = typeIdByName.get(typeName)
    if (!activityTypeId) errors.push(`Unknown activity_type: "${raw['activity_type']}" (must match one of the team's active types)`)

    // Title
    const title = raw['title'] ?? ''
    if (!title) errors.push('Missing title')

    // User assignment
    let userId = opts.defaultUserId
    if (opts.allowUserEmailColumn && raw['user_email']) {
      const mapped = teamMemberEmailToId.get(raw['user_email'].toLowerCase())
      if (!mapped) errors.push(`user_email "${raw['user_email']}" is not a member of the target team`)
      else userId = mapped
    }

    // Status
    const statusRaw = (raw['status'] ?? 'draft').toLowerCase()
    if (statusRaw !== 'draft' && statusRaw !== 'submitted') errors.push(`Invalid status: "${raw['status']}" (must be draft or submitted)`)
    const status = (statusRaw === 'submitted' ? 'submitted' : 'draft') as 'draft' | 'submitted'

    const row: ImportRow = { index: r + 1, raw, errors }
    if (errors.length === 0 && activityTypeId && !Number.isNaN(dt.getTime()) && Number.isFinite(duration)) {
      row.activity = {
        userId,
        teamId: opts.teamId,
        activityTypeId,
        title,
        startDatetime: dt,
        endDatetime: new Date(dt.getTime() + duration * 3600_000),
        effortHours: duration.toFixed(2),
        notes: raw['notes'] || null,
        status,
      }
      ready++
    }
    outRows.push(row)
  }
  return { rows: outRows, summary: { total: outRows.length, ready, errored: outRows.length - ready } }
}

// Commit every row from planImport that has no errors. All-or-nothing at the
// row level; a bad row is skipped, not rolled back. Returns the inserted row
// ids so the client can link straight to them.
export async function commitImport(plan: ImportRow[]): Promise<{ inserted: number }> {
  const ready = plan.filter((r) => !!r.activity).map((r) => r.activity!)
  if (ready.length === 0) return { inserted: 0 }
  await db.insert(activities).values(ready)
  return { inserted: ready.length }
}

// Convenience for the routes: plan + optional commit in one call.
export async function importActivitiesFromCsv(csvText: string, opts: ImportOptions & { dryRun?: boolean }): Promise<{
  summary: { total: number; ready: number; errored: number; inserted: number }
  rows: ImportRow[]
}> {
  const plan = await planImport(csvText, opts)
  if (opts.dryRun) return { summary: { ...plan.summary, inserted: 0 }, rows: plan.rows }
  const { inserted } = await commitImport(plan.rows)
  return { summary: { ...plan.summary, inserted }, rows: plan.rows }
}
