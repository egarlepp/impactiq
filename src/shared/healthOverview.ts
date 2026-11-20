// v1.440.0: App Health's System Health Overview (Admin → Monitoring → App
// Health). The server returns one tile per area; each tile is a status plus
// lines the client renders through t('admin.health.line.<key>', params).

// 'off' means not set up or not in use: it counts toward neither Healthy,
// Warnings nor Errors, so an install that doesn't use AI isn't flagged.
export const HEALTH_STATUSES = ['ok', 'warning', 'error', 'off'] as const
export type HealthStatus = typeof HEALTH_STATUSES[number]

export const HEALTH_TILE_IDS = ['database', 'jobs', 'queues', 'integrations', 'email', 'ai', 'data', 'app'] as const
export type HealthTileId = typeof HEALTH_TILE_IDS[number]

// Params the client formats before interpolating: `ageSec` → `age` (a
// duration), `at` → a local date/time, `bytes`/`heapBytes` → sizes, and
// `queue` / `integration` / `job` → their translated names.
export type HealthLineParams = Record<string, string | number>

export interface HealthLine {
  key: string
  status: HealthStatus
  params?: HealthLineParams
}

export interface HealthTile {
  id: HealthTileId
  status: HealthStatus
  lines: HealthLine[]
}

// v1.444.0: who has called /ready on the server that answered (in memory, per
// server process). Shown as a reminder, never counted as a warning.
export interface ReadinessCalls {
  processStartedAt: string
  lastCalledAt: string | null
  lastReady: boolean | null
  lastUserAgent: string | null
  callsLast24h: number
}

export interface HealthOverview {
  checkedAt: string
  tiles: HealthTile[]
  readiness: ReadinessCalls
}

// v1.444.0: how many days after the last backup download App Health starts
// reminding; 0 turns the reminder off.
export const BACKUP_REMINDER_DAY_OPTIONS = [0, 7, 14, 30, 90] as const
export type BackupReminderDays = typeof BACKUP_REMINDER_DAY_OPTIONS[number]
export const BACKUP_REMINDER_DAYS_DEFAULT: BackupReminderDays = 14

const RANK: Record<HealthStatus, number> = { off: 0, ok: 1, warning: 2, error: 3 }

// The worst status among the lines that are in use; 'off' only when every
// line is off (or there are none).
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = 'off'
  for (const s of statuses) if (RANK[s] > RANK[worst]) worst = s
  return worst
}
