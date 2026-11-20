// Full application database backup / restore (Admin → Monitoring & Audit →
// Backup & Restore). See CLAUDE.md §14d for the design writeup.
//
// File format — a gzip-compressed, line-oriented text file:
//
//   IMPACTIQ-BACKUP\t1
//   H\t{header json: appVersion, schema version, createdAt, keyCheck, tables}
//   T\t<table name>
//   R\t<row as JSON>          (zero or more, all belonging to the last T line)
//   ...
//   E\t{"counts": {table: rowCount}}
//
// Rows are produced by Postgres itself (`row_to_json(t)::text`) and written
// through verbatim, and on restore they're handed straight back to Postgres
// (`json_populate_recordset`) without ever being JSON.parse'd in Node — so a
// numeric/bigint wider than a JS double, a bytea, an array, a jsonb column or
// an enum round-trips byte-for-byte with no per-type code here. Postgres
// escapes newlines and tabs inside row_to_json output, so one row is always
// exactly one line.
//
// Every function takes the database handle as a parameter (rather than
// importing db/index.ts) so the same code runs against pglite in tests.
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import { sql, type SQL } from 'drizzle-orm'

export const BACKUP_MAGIC = 'IMPACTIQ-BACKUP'
export const BACKUP_FORMAT_VERSION = 1

// Never exported or restored. Sessions are per-deployment login state: a
// restore always signs every user out (the importing admin included), and
// they sign back in with the accounts that came over in the backup.
export const EXCLUDED_TABLES = new Set(['sessions'])

// system_settings rows that describe THIS deployment rather than the app's
// data. A restore keeps the target install's own values for these instead
// of taking the backup's: the public URL the new install is reachable at,
// a scheduled maintenance restart (a stale one from the source install
// would otherwise restart the new one the moment it's restored), and the
// cached "is there an update" result.
export const PRESERVED_SETTINGS_KEYS = ['app_public_base_url', 'maintenance_window', 'github_update_status']

// Minimal structural view of a Drizzle Postgres database or transaction —
// satisfied by both the production postgres-js db and the pglite test db.
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>
}
export interface BackupDb extends SqlExecutor {
  transaction<T>(
    fn: (tx: SqlExecutor) => Promise<T>,
    config?: { isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'; accessMode?: 'read only' | 'read write' },
  ): Promise<T>
}

export interface SchemaVersion {
  lastMigration: string
  migrationCount: number
}

export interface BackupHeader {
  format: number
  appVersion: string
  schema: SchemaVersion
  createdAt: string
  keyCheck: string
  tables: string[]
}

// postgres-js returns the row array directly; pglite returns { rows }.
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as T[]) : []
}

export async function listAppTables(db: SqlExecutor): Promise<string[]> {
  const rows = rowsOf<{ name: string }>(await db.execute(sql`
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  `))
  return rows.map((r) => r.name)
}

export async function countRows(db: SqlExecutor, tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const t of tables) {
    const [row] = rowsOf<{ n: number | string }>(await db.execute(sql`SELECT count(*) AS n FROM ${sql.identifier(t)}`))
    // count(*) is bigint — a string from postgres-js (CLAUDE.md §18 v1.308).
    counts[t] = Number(row?.n ?? 0)
  }
  return counts
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_PAGE_SIZE = 2000

// Writes the whole backup through `write` (which should resolve once the
// chunk is accepted, i.e. respect backpressure). Runs in a single read-only
// REPEATABLE READ transaction so every table comes from the same snapshot —
// an activity and its products can't be caught half-written. Each table is
// paged by ctid (a TID range scan, stable within the snapshot) rather than
// OFFSET, so a large table never turns into an O(n²) read.
export async function writeBackup(
  db: BackupDb,
  opts: { appVersion: string; schema: SchemaVersion; keyCheck: string },
  write: (chunk: string) => Promise<void>,
): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`)
    const tables = (await listAppTables(tx)).filter((t) => !EXCLUDED_TABLES.has(t))
    const header: BackupHeader = {
      format: BACKUP_FORMAT_VERSION,
      appVersion: opts.appVersion,
      schema: opts.schema,
      createdAt: new Date().toISOString(),
      keyCheck: opts.keyCheck,
      tables,
    }
    await write(`${BACKUP_MAGIC}\t${BACKUP_FORMAT_VERSION}\nH\t${JSON.stringify(header)}\n`)
    const counts: Record<string, number> = {}
    for (const table of tables) {
      await write(`T\t${table}\n`)
      let lastCtid: string | null = null
      let n = 0
      for (;;) {
        const page: { c: string; r: string }[] = rowsOf<{ c: string; r: string }>(await tx.execute(sql`
          SELECT t.ctid::text AS c, row_to_json(t)::text AS r
            FROM ${sql.identifier(table)} t
           ${lastCtid === null ? sql`` : sql`WHERE t.ctid > ${lastCtid}::tid`}
           ORDER BY t.ctid
           LIMIT ${EXPORT_PAGE_SIZE}
        `))
        if (page.length === 0) break
        let buf = ''
        for (const row of page) buf += `R\t${row.r}\n`
        await write(buf)
        n += page.length
        lastCtid = page[page.length - 1]!.c
        if (page.length < EXPORT_PAGE_SIZE) break
      }
      counts[table] = n
    }
    await write(`E\t${JSON.stringify({ counts })}\n`)
    return counts
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

// ---------------------------------------------------------------------------
// Reading a backup file
// ---------------------------------------------------------------------------

export class BackupFormatError extends Error {}

type BackupLine =
  | { kind: 'header'; header: BackupHeader }
  | { kind: 'table'; table: string }
  | { kind: 'row'; json: string }
  | { kind: 'end'; counts: Record<string, number> }

// Streams a gzip'd backup file line by line. Throws BackupFormatError on
// anything that isn't a well-formed ImpactIQ backup.
export async function* readBackupLines(filePath: string): AsyncGenerator<BackupLine> {
  const gunzip = createGunzip()
  const input = createReadStream(filePath).on('error', (e) => gunzip.destroy(e))
  const rl = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity })
  let lineNo = 0
  let sawEnd = false
  try {
    for await (const line of rl) {
      lineNo++
      if (line === '') continue
      if (sawEnd) throw new BackupFormatError('Unexpected content after end marker')
      if (lineNo === 1) {
        if (line !== `${BACKUP_MAGIC}\t${BACKUP_FORMAT_VERSION}`) {
          throw new BackupFormatError('Not an ImpactIQ backup file, or an unsupported backup format version')
        }
        continue
      }
      const tab = line.indexOf('\t')
      const tag = tab === -1 ? line : line.slice(0, tab)
      const rest = tab === -1 ? '' : line.slice(tab + 1)
      if (tag === 'R') yield { kind: 'row', json: rest }
      else if (tag === 'T') yield { kind: 'table', table: rest }
      else if (tag === 'H') yield { kind: 'header', header: JSON.parse(rest) as BackupHeader }
      else if (tag === 'E') {
        sawEnd = true
        const parsed = JSON.parse(rest) as { counts?: Record<string, number> }
        yield { kind: 'end', counts: parsed.counts ?? {} }
      } else throw new BackupFormatError(`Unrecognized line ${lineNo}`)
    }
  } catch (err) {
    if (err instanceof BackupFormatError) throw err
    // Gunzip errors, JSON.parse on a corrupted header/footer, etc.
    throw new BackupFormatError(`The backup file is corrupted or not gzip-compressed: ${(err as Error).message}`)
  } finally {
    rl.close()
    input.destroy()
  }
  if (lineNo === 0) throw new BackupFormatError('The backup file is empty')
  if (!sawEnd) throw new BackupFormatError('The backup file is incomplete (no end marker) — the download may have been cut off')
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface BackupAdmin {
  email: string
  displayName: string
}

export interface BackupIssue {
  code: 'count_mismatch' | 'schema_mismatch' | 'unknown_tables' | 'no_admin' | 'key_mismatch' | 'importer_missing'
  params?: Record<string, string | number>
}

export interface BackupPreview {
  header: BackupHeader
  // Per table: rows in the backup vs rows that will be replaced here.
  tables: { table: string; backupRows: number; currentRows: number }[]
  // Blocking problems — the restore is refused while any are present.
  // Codes, not prose: the client renders them through i18n
  // (admin.backup.issue.<code>) with `params` interpolated.
  errors: BackupIssue[]
  // Non-blocking things the admin should know before confirming.
  warnings: BackupIssue[]
  adminsInBackup: BackupAdmin[]
  importerInBackup: boolean
  keyMatches: boolean
}

// Scans the whole file once (validating structure and row counts) and
// compares it with this install. Never writes anything.
export async function previewBackup(
  db: SqlExecutor,
  filePath: string,
  target: { schema: SchemaVersion; keyCheck: string; importerEmail: string | null },
): Promise<BackupPreview> {
  let header: BackupHeader | null = null
  let currentTable: string | null = null
  const seen: Record<string, number> = {}
  let declared: Record<string, number> = {}
  const admins: BackupAdmin[] = []
  const emails = new Set<string>()

  for await (const line of readBackupLines(filePath)) {
    if (line.kind === 'header') {
      header = line.header
    } else if (line.kind === 'table') {
      if (!header) throw new BackupFormatError('Missing header')
      currentTable = line.table
      seen[currentTable] = seen[currentTable] ?? 0
    } else if (line.kind === 'row') {
      if (!currentTable) throw new BackupFormatError('Row before any table')
      seen[currentTable] = (seen[currentTable] ?? 0) + 1
      // The users table is the only one whose rows are read in Node — to
      // tell the admin which accounts they can sign back in with.
      if (currentTable === 'users') {
        const u = JSON.parse(line.json) as { email?: string; display_name?: string; is_app_admin?: boolean }
        if (u.email) emails.add(u.email.toLowerCase())
        if (u.is_app_admin && u.email) admins.push({ email: u.email, displayName: u.display_name ?? u.email })
      }
    } else {
      declared = line.counts
    }
  }
  if (!header) throw new BackupFormatError('Missing header')

  const errors: BackupIssue[] = []
  const warnings: BackupIssue[] = []

  for (const [t, n] of Object.entries(declared)) {
    if ((seen[t] ?? 0) !== n) errors.push({ code: 'count_mismatch', params: { table: t, expected: n, actual: seen[t] ?? 0 } })
  }

  if (header.schema.lastMigration !== target.schema.lastMigration || header.schema.migrationCount !== target.schema.migrationCount) {
    errors.push({
      code: 'schema_mismatch',
      params: { backupSchema: header.schema.lastMigration, backupVersion: header.appVersion, localSchema: target.schema.lastMigration },
    })
  }

  const localTables = new Set(await listAppTables(db))
  const unknown = Object.keys(seen).filter((t) => !localTables.has(t) || EXCLUDED_TABLES.has(t))
  if (unknown.length) errors.push({ code: 'unknown_tables', params: { tables: unknown.join(', ') } })

  const restorable = [...localTables].filter((t) => !EXCLUDED_TABLES.has(t))
  const current = await countRows(db, restorable)
  const tables = restorable.map((t) => ({ table: t, backupRows: seen[t] ?? 0, currentRows: current[t] ?? 0 }))

  if (admins.length === 0) {
    errors.push({ code: 'no_admin' })
  }

  const keyMatches = header.keyCheck === target.keyCheck
  if (!keyMatches) {
    warnings.push({ code: 'key_mismatch' })
  }

  const importerInBackup = !!target.importerEmail && emails.has(target.importerEmail.toLowerCase())
  if (!importerInBackup) {
    warnings.push({ code: 'importer_missing' })
  }

  return { header, tables, errors, warnings, adminsInBackup: admins, importerInBackup, keyMatches }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

const INSERT_BATCH_ROWS = 500
const INSERT_BATCH_CHARS = 4_000_000

async function insertBatch(tx: SqlExecutor, table: string, columns: string[], rows: string[]): Promise<void> {
  if (rows.length === 0) return
  const ident = sql.identifier(table)
  const cols = sql.join(columns.map((c) => sql.identifier(c)), sql`, `)
  const payload = `[${rows.join(',')}]`
  // OVERRIDING SYSTEM VALUE keeps exported ids even for GENERATED ALWAYS
  // identity columns (a no-op on tables without one).
  await tx.execute(sql`
    INSERT INTO ${ident} (${cols}) OVERRIDING SYSTEM VALUE
    SELECT ${cols} FROM json_populate_recordset(NULL::${ident}, ${payload}::json)
  `)
}

// Replaces every application table with the backup's contents inside ONE
// transaction: any failure (a bad row, a broken foreign key) rolls the whole
// thing back and the install is exactly as it was. Callers must have run
// previewBackup() and refused on errors first.
//
// Foreign keys are dropped and re-created inside the transaction (Postgres
// DDL is transactional) instead of ordering inserts by dependency — that
// handles self-references and cycles with no ordering logic, and re-adding
// each constraint re-validates every row, so a restore can never leave a
// dangling reference behind.
export async function restoreBackup(
  db: BackupDb,
  filePath: string,
  importer: { userId: string | null; email: string | null; ip: string | null; userAgent: string | null },
  meta: Record<string, unknown>,
): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`)
    await tx.execute(sql`SET LOCAL lock_timeout = '60s'`)

    const tables = await listAppTables(tx)
    const restorable = new Set(tables.filter((t) => !EXCLUDED_TABLES.has(t)))

    const preserved = rowsOf<{ key: string; value: string; updated_at: string }>(await tx.execute(sql`
      SELECT key, value::text AS value, updated_at::text AS updated_at
        FROM system_settings
       WHERE key IN (${sql.join(PRESERVED_SETTINGS_KEYS.map((k) => sql`${k}`), sql`, `)})
    `))

    const fks = rowsOf<{ drop_sql: string; add_sql: string }>(await tx.execute(sql`
      SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) AS drop_sql,
             format('ALTER TABLE %s ADD CONSTRAINT %I %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) AS add_sql
        FROM pg_constraint
       WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `))
    for (const fk of fks) await tx.execute(sql.raw(fk.drop_sql))

    // Every table, sessions included — a restore signs everyone out.
    await tx.execute(sql`TRUNCATE ${sql.join(tables.map((t) => sql.identifier(t)), sql`, `)}`)

    const columnCache = new Map<string, string[]>()
    async function insertableColumns(table: string): Promise<string[]> {
      const cached = columnCache.get(table)
      if (cached) return cached
      const cols = rowsOf<{ name: string }>(await tx.execute(sql`
        SELECT attname AS name FROM pg_attribute
         WHERE attrelid = (quote_ident('public') || '.' || quote_ident(${table}))::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
         ORDER BY attnum
      `)).map((r) => r.name)
      columnCache.set(table, cols)
      return cols
    }

    const counts: Record<string, number> = {}
    let table: string | null = null
    let columns: string[] = []
    let batch: string[] = []
    let batchChars = 0
    const flush = async () => {
      if (table && batch.length) await insertBatch(tx, table, columns, batch)
      batch = []
      batchChars = 0
    }

    for await (const line of readBackupLines(filePath)) {
      if (line.kind === 'table') {
        await flush()
        if (!restorable.has(line.table)) throw new BackupFormatError(`Unknown table in backup: ${line.table}`)
        table = line.table
        columns = await insertableColumns(table)
        counts[table] = 0
      } else if (line.kind === 'row') {
        if (!table) throw new BackupFormatError('Row before any table')
        batch.push(line.json)
        batchChars += line.json.length
        counts[table] = (counts[table] ?? 0) + 1
        if (batch.length >= INSERT_BATCH_ROWS || batchChars >= INSERT_BATCH_CHARS) await flush()
      }
    }
    await flush()

    for (const fk of fks) await tx.execute(sql.raw(fk.add_sql))

    // Serial / identity columns (none today — every id is a uuid — but a
    // future one must not hand out ids that collide with restored rows).
    const seqs = rowsOf<{ stmt: string }>(await tx.execute(sql`
      SELECT format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 0) + 1, false)', s.seq, a.attname, c.relname) AS stmt
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN LATERAL (SELECT pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq) s
       WHERE c.relkind IN ('r', 'p') AND s.seq IS NOT NULL
    `))
    for (const s of seqs) await tx.execute(sql.raw(s.stmt))

    await tx.execute(sql`DELETE FROM system_settings WHERE key IN (${sql.join(PRESERVED_SETTINGS_KEYS.map((k) => sql`${k}`), sql`, `)})`)
    for (const p of preserved) {
      await tx.execute(sql`INSERT INTO system_settings (key, value, updated_at) VALUES (${p.key}, ${p.value}::jsonb, ${p.updated_at}::timestamptz)`)
    }

    // Written last, inside the same transaction, so it lands in the RESTORED
    // audit log (anything written before the TRUNCATE is gone). The actor id
    // is kept only if that user also exists in the restored data.
    await tx.execute(sql`
      INSERT INTO audit_events (actor_user_id, actor_email, action, target_type, target_id, meta, ip, user_agent)
      VALUES (
        (SELECT id FROM users WHERE id::text = ${importer.userId ?? ''}),
        ${importer.email}, 'system_backup.restore', 'database', NULL,
        ${JSON.stringify({ ...meta, rowCounts: counts })}::jsonb,
        ${importer.ip}, ${importer.userAgent}
      )
    `)
    return counts
  })
}
