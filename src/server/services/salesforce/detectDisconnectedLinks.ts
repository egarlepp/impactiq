import { db } from '../../db/index.js'
import { activities } from '../../../../drizzle/schema.js'
import { eq, sql, and, isNotNull } from 'drizzle-orm'
import { getAdminSfConnection } from './client.js'
import { checkSfRecordsExist } from './referenceResolver.js'
import { writeRun } from '../jobs/writeRun.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { isCriteriaIqProjectLink } from '../../../shared/evaluationSource.js'
import { notDemoCrmId } from '../demo/ids.js'

// v1.344.0: nightly batch detection of activities whose linked Salesforce
// record (What/Who/Related) has since been deleted — see CLAUDE.md §7. SF
// records can be deleted after an activity already links to them; today
// there is no signal anywhere that this happened, so a stale link just sits
// there silently forever. This job scans every distinct (linkField,
// objectType) pair actually present on `activities`, batch-checks existence
// against the admin SF connection, and self-heals the 3 crm_*_deleted flags
// (clears back to false if a record is found again — restored from Recycle
// Bin, or a prior transient failure now resolved).
//
// Modeled directly on refreshOppSnapshots.ts (chunking, writeRun,
// scheduleJob registration) but deliberately isolates failures per chunk
// rather than sharing one big try/catch (won-without-poc's convention) —
// this job scans every team's every object type in one run, so one
// misconfigured Related-object string (Related is per-team admin-configured
// free text) must not blank everyone else's results. A chunk whose query
// THROWS writes nothing for that chunk (existing flags + checkedAt left
// untouched) — checkSfRecordsExist() only ever reports a flag as true on a
// SUCCESSFUL query that omits the requested id, matching the "absent from a
// failed fetch is not the same as deleted" precedent from Deleted Outlook
// Activities (§10).

const CHUNK_SIZE = 200
const OBJECT_TYPE_RX = /^[A-Za-z0-9_]{1,80}$/

export interface DetectResult {
  whatScanned: number
  whatDeletedFound: number
  whoScanned: number
  whoDeletedFound: number
  relatedScanned: number
  relatedDeletedFound: number
  errors: string[]
  durationMs: number
  source?: 'scheduled' | 'manual'
}

type LinkField = 'crmWhatId' | 'crmWhoId' | 'crmRelatedId'
const FLAG_COLUMN: Record<LinkField, 'crm_what_deleted' | 'crm_who_deleted' | 'crm_related_deleted'> = {
  crmWhatId: 'crm_what_deleted',
  crmWhoId: 'crm_who_deleted',
  crmRelatedId: 'crm_related_deleted',
}
const ID_COLUMN: Record<LinkField, 'crm_what_id' | 'crm_who_id' | 'crm_related_id'> = {
  crmWhatId: 'crm_what_id',
  crmWhoId: 'crm_who_id',
  crmRelatedId: 'crm_related_id',
}

// Bulk-writes one UPDATE...FROM(VALUES...) per chunk, mirroring
// refreshOppSnapshots.ts's bulkUpdateOppPatches — writes both true AND
// false so a record found again after a prior deleted flag self-heals.
async function bulkUpdateFlags(
  linkField: LinkField,
  rows: Array<{ id: string; deleted: boolean }>,
): Promise<void> {
  if (rows.length === 0) return
  const idCol = ID_COLUMN[linkField]
  const flagCol = FLAG_COLUMN[linkField]
  const values = sql.join(
    rows.map((r) => sql`(${r.id}, ${r.deleted})`),
    sql`, `,
  )
  await db.execute(sql`
    UPDATE activities AS a SET
      ${sql.raw(flagCol)} = v.deleted,
      crm_disconnect_checked_at = now()
    FROM (VALUES ${values}) AS v(link_id, deleted)
    WHERE a.${sql.raw(idCol)} = v.link_id
  `)
}

interface TypeGroup {
  objectType: string
  ids: string[]
}

async function discoverTypeGroups(linkField: LinkField): Promise<TypeGroup[]> {
  const typeCol = linkField === 'crmWhatId' ? activities.crmWhatType : linkField === 'crmWhoId' ? activities.crmWhoType : activities.crmRelatedType
  const idCol = linkField === 'crmWhatId' ? activities.crmWhatId : linkField === 'crmWhoId' ? activities.crmWhoId : activities.crmRelatedId
  const rows = await db
    .selectDistinct({ type: typeCol, id: idCol })
    .from(activities)
    .where(and(eq(activities.isArchived, false), isNotNull(idCol), isNotNull(typeCol), notDemoCrmId(idCol)))
  const idsByType = new Map<string, string[]>()
  for (const r of rows) {
    const type = r.type as string | null
    const id = r.id as string | null
    if (!type || !id) continue
    // CriteriaIQ project links (CriteriaIQ as the primary Project source)
    // aren't Salesforce records; refresh_criteriaiq_projects checks them.
    if (linkField === 'crmRelatedId' && isCriteriaIqProjectLink(type)) continue
    const list = idsByType.get(type) ?? []
    list.push(id)
    idsByType.set(type, list)
  }
  return Array.from(idsByType.entries()).map(([objectType, ids]) => ({ objectType, ids }))
}

async function processLinkField(
  linkField: LinkField,
  conn: NonNullable<Awaited<ReturnType<typeof getAdminSfConnection>>>,
  result: DetectResult,
  scannedKey: 'whatScanned' | 'whoScanned' | 'relatedScanned',
  foundKey: 'whatDeletedFound' | 'whoDeletedFound' | 'relatedDeletedFound',
): Promise<void> {
  const groups = await discoverTypeGroups(linkField)
  for (const { objectType, ids } of groups) {
    if (!OBJECT_TYPE_RX.test(objectType)) {
      result.errors.push(`${linkField}_invalid_object_type: ${objectType.slice(0, 40)}`)
      continue
    }
    result[scannedKey] += ids.length
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE)
      try {
        const existsById = await checkSfRecordsExist(conn, objectType, chunk)
        const patches = chunk.map((id) => ({ id, deleted: !(existsById.get(id) ?? true) }))
        await bulkUpdateFlags(linkField, patches)
        result[foundKey] += patches.filter((p) => p.deleted).length
      } catch (e) {
        // Query threw — leave this chunk's existing flags untouched. Never
        // treat a failed check as "confirmed deleted."
        result.errors.push(`${linkField}_${objectType}_chunk_${i}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}

export async function detectDisconnectedLinks(opts?: { source?: 'scheduled' | 'manual' }): Promise<DetectResult> {
  const startedAt = new Date()
  const result: DetectResult = {
    whatScanned: 0, whatDeletedFound: 0,
    whoScanned: 0, whoDeletedFound: 0,
    relatedScanned: 0, relatedDeletedFound: 0,
    errors: [], durationMs: 0, source: opts?.source ?? 'scheduled',
  }
  const conn = await getAdminSfConnection()
  if (!conn) {
    result.errors.push('no_admin_sf_connection')
    await writeRun('detect_disconnected_links', startedAt, 'error', 'no_admin_sf_connection', result)
    return result
  }

  await processLinkField('crmWhatId', conn, result, 'whatScanned', 'whatDeletedFound')
  await processLinkField('crmWhoId', conn, result, 'whoScanned', 'whoDeletedFound')
  await processLinkField('crmRelatedId', conn, result, 'relatedScanned', 'relatedDeletedFound')

  result.durationMs = Date.now() - startedAt.getTime()
  const message = `${result.whatDeletedFound}/${result.whatScanned} What, ${result.whoDeletedFound}/${result.whoScanned} Who, ${result.relatedDeletedFound}/${result.relatedScanned} Related flagged disconnected`
  await writeRun('detect_disconnected_links', startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}

// v1.344.0: nightly cron loop, started from src/server/index.ts. 24h cadence
// matches refresh_opp_snapshots — SF deletion is rare and there's no cheap
// incremental signal for it (unlike the watermark-based Opp refresh, a
// deleted record can't be found by a SystemModstamp >= filter, so every run
// is necessarily a full distinct-type scan regardless of cadence).
// Admin-adjustable afterward via job_config, same as every scheduleJob().
let stopFn: (() => void) | null = null
export function startDisconnectedLinksWorker() {
  if (stopFn) return
  stopFn = scheduleJob('detect_disconnected_links', 24 * 60 * 60 * 1000, async () => {
    // Salesforce-only job: a quiet no-op when the install runs another CRM.
    if (!(await isCrmProviderActive('salesforce'))) return
    await detectDisconnectedLinks().catch(() => {})
  }, { firstRunDelayMs: 90 * 1000 })
}
