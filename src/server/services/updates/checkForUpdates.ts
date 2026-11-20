// v1.332.0: App Update check — Phase 1 (read-only: "is there an update, and
// what changed"). Deliberately host-independent — see CLAUDE.md's App
// Updates note. No Dokploy/Docker/CI assumption of any kind: this reads
// `src/shared/changelog.ts` off the pinned branch via the plain GitHub
// Contents API and compares its newest entry's version against this
// server's own `APP_VERSION` (imported from the same file every release
// bump already keeps in lockstep per CLAUDE.md §20b). There is deliberately
// no redeploy/restart trigger yet — Phase 2, not built here.
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { encryptToken, decryptToken } from '../config/crypto.js'
import { APP_VERSION } from '../../../shared/appVersion.js'
import { parseChangelogSource, entriesNewerThan, type ParsedChangelogEntry } from './parseChangelog.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'

export const UPDATE_CHECK_JOB_KEY = 'check_for_updates'

const CONFIG_KEY = 'github_update_config'
const STATUS_KEY = 'github_update_status'
const CHANGELOG_PATH = 'src/shared/changelog.ts'

// The branch this feature reads from is intentionally fixed, not an admin-
// editable field — "pinned" means exactly that. Still surfaced to the admin
// (getUpdateConfigSummary) per the explicit requirement that it be visible,
// not just assumed.
export const PINNED_BRANCH = 'main'

interface GithubUpdateConfig {
  owner: string
  repo: string
  patEncrypted: string
}

export interface UpdateConfigSummary {
  configured: boolean
  owner: string | null
  repo: string | null
  pinnedBranch: string
}

export interface UpdateCheckStatus {
  checkedAt: string | null
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  newEntries: ParsedChangelogEntry[]
  error: string | null
}

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1)
  return (row?.value as T | undefined) ?? null
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const [existing] = await db.select({ key: systemSettings.key }).from(systemSettings).where(eq(systemSettings.key, key)).limit(1)
  if (existing) {
    await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key))
  } else {
    await db.insert(systemSettings).values({ key, value })
  }
}

async function loadConfig(): Promise<GithubUpdateConfig | null> {
  const cfg = await readSetting<GithubUpdateConfig>(CONFIG_KEY)
  if (!cfg?.patEncrypted || !cfg.owner || !cfg.repo) return null
  return cfg
}

// requireDefaultAdmin-gated at the route layer — see rbac.ts and CLAUDE.md.
export async function setUpdateConfig(owner: string, repo: string, pat: string): Promise<void> {
  const value: GithubUpdateConfig = { owner: owner.trim(), repo: repo.trim(), patEncrypted: encryptToken(pat) }
  await writeSetting(CONFIG_KEY, value)
}

export async function clearUpdateConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, CONFIG_KEY))
  await db.delete(systemSettings).where(eq(systemSettings.key, STATUS_KEY))
}

export async function getUpdateConfigSummary(): Promise<UpdateConfigSummary> {
  const cfg = await loadConfig()
  return { configured: !!cfg, owner: cfg?.owner ?? null, repo: cfg?.repo ?? null, pinnedBranch: PINNED_BRANCH }
}

// Cached result of the last check — what every read-only surface (sidebar
// dot, the update modal on open) shows without hitting GitHub itself. Only
// checkForUpdates() (the scheduled job, or an explicit Check Now) refreshes
// this.
export async function getCachedUpdateStatus(): Promise<UpdateCheckStatus | null> {
  return readSetting<UpdateCheckStatus>(STATUS_KEY)
}

async function fetchChangelogSource(cfg: GithubUpdateConfig): Promise<string> {
  const pat = decryptToken(cfg.patEncrypted)
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${CHANGELOG_PATH}?ref=${encodeURIComponent(PINNED_BRANCH)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github.v3.raw',
        'User-Agent': 'ImpactIQ-App-Update-Check',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub returned ${res.status}${res.status === 401 || res.status === 403 ? ' (check the token)' : ''}${res.status === 404 ? ' (check owner/repo/branch)' : ''}: ${body.slice(0, 200)}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timeout)
  }
}

// Runs a live check against GitHub and persists the result. Called by the
// scheduled job on its own cadence, and by the admin's "Check now" button
// (requireAppAdmin — viewing is not the gated action, only configuring/
// clearing the token is).
export async function checkForUpdates(): Promise<UpdateCheckStatus> {
  const checkedAt = new Date().toISOString()
  const cfg = await loadConfig()
  if (!cfg) {
    const status: UpdateCheckStatus = {
      checkedAt,
      currentVersion: APP_VERSION,
      latestVersion: null,
      updateAvailable: false,
      newEntries: [],
      error: 'not_configured',
    }
    await writeSetting(STATUS_KEY, status)
    return status
  }
  try {
    const source = await fetchChangelogSource(cfg)
    const entries = parseChangelogSource(source)
    const latest = entries[0] ?? null
    const newEntries = latest ? entriesNewerThan(entries, APP_VERSION) : []
    const status: UpdateCheckStatus = {
      checkedAt,
      currentVersion: APP_VERSION,
      latestVersion: latest?.version ?? null,
      updateAvailable: newEntries.length > 0,
      newEntries,
      error: null,
    }
    await writeSetting(STATUS_KEY, status)
    return status
  } catch (err) {
    const status: UpdateCheckStatus = {
      checkedAt,
      currentVersion: APP_VERSION,
      latestVersion: null,
      updateAvailable: false,
      newEntries: [],
      error: err instanceof Error ? err.message : 'unknown_error',
    }
    await writeSetting(STATUS_KEY, status)
    return status
  }
}

// Background poller — see index.ts. Not configured (the common case until an
// admin sets it up) is a genuine no-op tick and deliberately writes no
// job_runs row, same "only log real work" gate every other fast-tick job in
// this app already follows (CLAUDE.md's Scheduling entry). Once configured,
// every tick is real work (a live GitHub call) and always records a run,
// success or failure, the same as refresh_opp_coverage/refresh_opp_snapshots.
let stopFn: (() => void) | null = null
export function startUpdateCheckWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(UPDATE_CHECK_JOB_KEY, 6 * 60 * 60 * 1000, async () => {
    const startedAt = new Date()
    const cfg = await loadConfig()
    if (!cfg) return
    const status = await checkForUpdates()
    await writeRun(
      UPDATE_CHECK_JOB_KEY,
      startedAt,
      status.error ? 'error' : 'ok',
      status.error ?? (status.updateAvailable ? `update available: ${status.latestVersion}` : `up to date (${status.currentVersion})`),
      status,
    )
    // v1.335.0: this worker is started unconditionally on every boot
    // (index.ts), so a short firstRunDelayMs — not the full 6h interval —
    // is what makes the cached status self-correct promptly after ANY
    // restart, including the scheduled one restartScheduler.ts triggers.
    // Without this, a real out-of-band deploy (new code staged, container
    // restarted) could sit for up to 6h still showing the old "update
    // available" banner, since the cached github_update_status row was
    // computed by the PREVIOUS process against the OLD APP_VERSION.
  }, { firstRunDelayMs: 10 * 1000 })
}
