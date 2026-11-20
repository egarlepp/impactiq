// Admin → Monitoring & Audit → Backup & Restore (CLAUDE.md §14d). Mounted on
// adminRouter at /backup, behind its requireGlobalAdmin gate, and every
// route here additionally requires App Admin: a backup holds the whole
// database (password hashes and encrypted tokens included) and a restore
// replaces it, so neither belongs to a Team Admin.
import { Router, type Request } from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { db, findMigrationsFolder } from '../db/index.js'
import { requireAppAdmin } from '../middleware/rbac.js'
import { logAudit } from '../services/audit/log.js'
import { encryptionKeyCheck } from '../services/config/crypto.js'
import { reloadIntegrationConfigs } from '../services/config/integrations.js'
import { clearAiCache } from '../services/ai/providers.js'
import { loadAuthPolicy } from '../services/config/auth-policy.js'
import { loadRateLimitSettings } from '../services/config/rate-limit-config.js'
import { clearCrmFeaturesCache } from '../services/crm/features.js'
import { clearTerminologyCache } from '../services/config/terminology.js'
import { clearCrmProviderCache } from '../services/crm/providerSetting.js'
import { clearEvaluationSourceCache } from '../services/criteriaiq/evaluationSource.js'
import { clearCriteriaIqCache } from '../services/criteriaiq/client.js'
import { APP_VERSION } from '../../shared/appVersion.js'
import {
  writeBackup, previewBackup, restoreBackup, countRows, listAppTables,
  BackupFormatError, EXCLUDED_TABLES,
  type BackupDb, type BackupPreview, type SchemaVersion,
} from '../services/backup/backup.js'
import { getBackupStatus, recordBackupCompleted, setBackupReminderDays } from '../services/backup/lastBackup.js'
import { BACKUP_REMINDER_DAY_OPTIONS, type BackupReminderDays } from '../../shared/healthOverview.js'

export const backupRouter = Router()
backupRouter.use(requireAppAdmin)

const backupDb = db as unknown as BackupDb

// The schema version this build expects — the newest migration in the
// journal, which the server applies on every boot.
function currentSchemaVersion(): SchemaVersion {
  const journal = JSON.parse(fs.readFileSync(path.join(findMigrationsFolder(), 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[]
  }
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)
  return { lastMigration: entries[entries.length - 1]?.tag ?? 'none', migrationCount: entries.length }
}

function maxUploadBytes(): number {
  const mb = Number(process.env['BACKUP_MAX_UPLOAD_MB'])
  return (Number.isFinite(mb) && mb > 0 ? mb : 2048) * 1024 * 1024
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

backupRouter.get('/info', async (_req, res) => {
  try {
    const tables = (await listAppTables(db)).filter((t) => !EXCLUDED_TABLES.has(t))
    const counts = await countRows(db, tables)
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)
    const backup = await getBackupStatus()
    res.json({
      data: {
        appVersion: APP_VERSION, schema: currentSchemaVersion(), tableCount: tables.length, totalRows, maxUploadMb: Math.round(maxUploadBytes() / 1024 / 1024),
        lastBackupAt: backup.lastBackupAt, reminderDays: backup.reminderDays,
      },
      error: null,
      meta: {},
    })
  } catch (err) {
    res.status(500).json({ data: null, error: (err as Error).message, meta: {} })
  }
})

// ---------------------------------------------------------------------------
// Export — streamed straight to the browser as a download
// ---------------------------------------------------------------------------

backupRouter.get('/export', async (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `impactiq-backup-v${APP_VERSION}-${stamp}.iqbackup.gz`
  await logAudit(req, { action: 'system_backup.export', targetType: 'database', meta: { appVersion: APP_VERSION, schema: currentSchemaVersion() } })

  res.setHeader('Content-Type', 'application/gzip')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Cache-Control', 'no-store')
  const gzip = createGzip()
  gzip.pipe(res)
  const write = (chunk: string) => new Promise<void>((resolve, reject) => {
    if (res.destroyed) { reject(new Error('Client disconnected')); return }
    if (gzip.write(chunk)) resolve()
    else gzip.once('drain', resolve)
  })
  try {
    await writeBackup(backupDb, { appVersion: APP_VERSION, schema: currentSchemaVersion(), keyCheck: encryptionKeyCheck() }, write)
    gzip.end()
    // App Health's Data tile reminds admins when this gets old.
    await recordBackupCompleted(req.user!.id, APP_VERSION).catch((err) => {
      console.warn('[backup] could not record the backup time:', err instanceof Error ? err.message : String(err))
    })
  } catch (err) {
    console.error('[backup] export failed:', err)
    // Headers are already sent, so the only honest signal left is to abort
    // the download — the browser shows it as failed, and the file (which
    // would lack its end marker) is rejected if anyone tries to restore it.
    gzip.destroy()
    res.destroy()
  }
})

// v1.444.0: how many days after the last backup App Health reminds admins
// (0 = never, for a host that already backs up the database).
backupRouter.put('/reminder', async (req, res) => {
  const days: unknown = req.body?.days
  if (typeof days !== 'number' || !(BACKUP_REMINDER_DAY_OPTIONS as readonly number[]).includes(days)) {
    res.status(400).json({ data: null, error: 'errors.validation.invalid_value', meta: {} })
    return
  }
  await setBackupReminderDays(days as BackupReminderDays)
  await logAudit(req, { action: 'system_backup.reminder', targetType: 'database', meta: { days } })
  res.json({ data: { reminderDays: days }, error: null, meta: {} })
})

// ---------------------------------------------------------------------------
// Import — step 1: upload + preview (writes nothing to the database)
// ---------------------------------------------------------------------------

interface PendingImport {
  filePath: string
  userId: string
  uploadedAt: number
  preview: BackupPreview
  originalName: string | null
}

const PENDING_TTL_MS = 30 * 60 * 1000
const pending = new Map<string, PendingImport>()

function discard(token: string): void {
  const p = pending.get(token)
  if (!p) return
  pending.delete(token)
  fs.rm(path.dirname(p.filePath), { recursive: true, force: true }, () => {})
}

setInterval(() => {
  const now = Date.now()
  for (const [token, p] of pending) if (now - p.uploadedAt > PENDING_TTL_MS) discard(token)
}, 5 * 60 * 1000).unref()

async function saveUpload(req: Request, dest: string): Promise<void> {
  const limit = maxUploadBytes()
  let received = 0
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      if (received > limit) cb(new Error('errors.backup.too_large'))
      else cb(null, chunk)
    },
  })
  await pipeline(req, guard, fs.createWriteStream(dest))
  if (received === 0) throw new Error('errors.backup.empty_upload')
}

backupRouter.post('/import', async (req, res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impactiq-restore-'))
  const filePath = path.join(dir, 'upload.iqbackup.gz')
  try {
    await saveUpload(req, filePath)
    const preview = await previewBackup(db, filePath, {
      schema: currentSchemaVersion(),
      keyCheck: encryptionKeyCheck(),
      importerEmail: req.user?.email ?? null,
    })
    // Only one pending upload per admin — a new upload replaces the last.
    for (const [token, p] of pending) if (p.userId === req.user!.id) discard(token)
    const token = randomBytes(24).toString('hex')
    const name = typeof req.headers['x-file-name'] === 'string' ? decodeURIComponent(req.headers['x-file-name']).slice(0, 200) : null
    pending.set(token, { filePath, userId: req.user!.id, uploadedAt: Date.now(), preview, originalName: name })
    res.json({ data: { token, preview }, error: null, meta: {} })
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true }, () => {})
    const msg = (err as Error).message
    if (err instanceof BackupFormatError) {
      res.status(400).json({ data: null, error: `errors.backup.invalid_file|detail=${msg.replace(/\|/g, '/')}`, meta: {} })
    } else if (msg.startsWith('errors.backup.')) {
      res.status(msg === 'errors.backup.too_large' ? 413 : 400).json({ data: null, error: msg, meta: {} })
    } else {
      console.error('[backup] upload/preview failed:', err)
      res.status(500).json({ data: null, error: msg, meta: {} })
    }
  }
})

backupRouter.delete('/import/:token', (req, res) => {
  const p = pending.get(req.params['token'] ?? '')
  if (p && p.userId === req.user!.id) discard(req.params['token']!)
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// ---------------------------------------------------------------------------
// Import — step 2: apply (replaces the whole database in one transaction)
// ---------------------------------------------------------------------------

export const RESTORE_CONFIRMATION = 'RESTORE'

backupRouter.post('/import/:token/apply', async (req, res) => {
  const token = req.params['token'] ?? ''
  const p = pending.get(token)
  if (!p || p.userId !== req.user!.id) {
    res.status(404).json({ data: null, error: 'errors.backup.upload_expired', meta: {} })
    return
  }
  const body = (req.body ?? {}) as { confirmation?: unknown }
  if (body.confirmation !== RESTORE_CONFIRMATION) {
    res.status(400).json({ data: null, error: 'errors.backup.confirmation_required', meta: {} })
    return
  }
  if (p.preview.errors.length > 0) {
    res.status(400).json({ data: null, error: 'errors.backup.not_restorable', meta: {} })
    return
  }
  // Re-check compatibility at apply time: the server may have been upgraded
  // between the preview and the click.
  const schema = currentSchemaVersion()
  if (p.preview.header.schema.lastMigration !== schema.lastMigration) {
    res.status(409).json({ data: null, error: 'errors.backup.not_restorable', meta: {} })
    return
  }

  const meta = {
    fileName: p.originalName,
    backupCreatedAt: p.preview.header.createdAt,
    backupAppVersion: p.preview.header.appVersion,
    schema: p.preview.header.schema,
    keyMatches: p.preview.keyMatches,
  }
  try {
    const counts = await restoreBackup(backupDb, p.filePath, {
      userId: req.user!.id,
      email: req.user!.email ?? null,
      ip: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    }, meta)
    discard(token)
    // Settings the server caches in memory at boot now come from the
    // restored database.
    clearCrmFeaturesCache()
    clearTerminologyCache()
    clearCrmProviderCache()
    clearEvaluationSourceCache()
    clearCriteriaIqCache()
    clearAiCache()
    await Promise.allSettled([reloadIntegrationConfigs(), loadAuthPolicy(), loadRateLimitSettings()])
    // Every session was removed by the restore — the caller included. The
    // client sends them to the sign-in page next.
    res.json({ data: { counts, signedOut: true }, error: null, meta: {} })
  } catch (err) {
    console.error('[backup] restore failed (rolled back):', err)
    await logAudit(req, { action: 'system_backup.restore_failed', targetType: 'database', meta: { ...meta, error: (err as Error).message } })
    res.status(500).json({ data: null, error: `errors.backup.restore_failed|message=${(err as Error).message.replace(/\|/g, '/').slice(0, 300)}`, meta: {} })
  }
})
