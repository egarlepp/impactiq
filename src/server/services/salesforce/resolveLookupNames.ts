import type jsforce from 'jsforce'
import { inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { crmUsers } from '../../../../drizzle/schema.js'
import { safeSoqlLiteral } from './soql.js'

// Duplicated from preview.ts rather than imported from it: preview.ts
// imports from refreshOppSnapshots.ts, which needs this module, and
// refreshOppSnapshots.ts importing preview.ts back would be a cycle.
const SF_ID_RX = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/

// v1.286.0: crm_field_mappings.reference_to is already captured automatically
// from Salesforce describe() metadata whenever an admin maps a field that
// turns out to be a lookup (SfFieldMappings.tsx's submitAdd/saveRowEdit) —
// until now it was purely a UI hint ("→ User"). A lookup field's raw value
// is a Salesforce Id, not a display name — e.g. Evaluations__c's
// Primary_Engineer__c is a genuine Lookup(User), unlike Opportunity's
// Assigned_SE__c, which is a picklist string — so any field mapped straight
// to a User lookup showed a bare Id (0054u000...) until this resolves it.
//
// Resolved against the LOCAL crm_users cache (kept current by Sales Team
// Alignment's user sync) rather than a second live SF round-trip per record:
// cheap, and it already has to exist for the Alignment feature to work.
//
// Scoped to User only — the one local cache this app maintains. A lookup to
// Contact/Account/etc. is left as the raw Id; supporting those would need
// their own local cache the same way crm_users exists for User, which
// nothing today provides.
export async function resolveUserLookupNames(
  rawIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(rawIds.filter((v): v is string => !!v && SF_ID_RX.test(v))))
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: crmUsers.id, name: crmUsers.name }).from(crmUsers).where(inArray(crmUsers.id, ids))
  return new Map(rows.map((r) => [r.id, r.name] as const))
}

// v1.340.0: Owner-shaped fields (Case.OwnerId and the same pattern on any
// other ticket/case-like object) are POLYMORPHIC — describe() reports
// `referenceTo: ['User', 'Group']` (or the reverse order depending on the
// org), because a record can be owned by an individual OR by a Queue at
// any given time, and genuinely flips between the two over its lifecycle.
// SfFieldMappings.tsx's auto-capture only ever stores referenceTo[0] — a
// single scalar can't represent "could be either" — so resolveUserLookupNames()
// alone silently failed (left the raw Id showing) exactly when a ticket's
// current owner happened to be a Queue: `00G...`-prefixed Ids are Group
// records, not User records, so they were never in `crm_users` to begin with.
// This resolver tries the free, already-current local `crm_users` cache
// first, then falls back to a single live SOQL query against `Group` (which
// covers Queues — a Queue is stored as a Group with Type='Queue') for
// whatever's left unresolved. Deliberately no local Group/Queue cache table
// — queues are far less numerous and change far less often than users, so a
// live round-trip per distinct owner Id per request is cheap, unlike doing
// the same for every user on every request (which is exactly why crm_users
// exists as a cache in the first place).
export async function resolveOwnerLookupNames(
  conn: jsforce.Connection,
  rawIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(rawIds.filter((v): v is string => !!v && SF_ID_RX.test(v))))
  if (ids.length === 0) return new Map()

  const result = await resolveUserLookupNames(ids)
  const remaining = ids.filter((id) => !result.has(id))
  if (remaining.length === 0) return result

  try {
    const list = remaining.map((id) => `'${safeSoqlLiteral(id)}'`).join(', ')
    const q = await conn.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM Group WHERE Id IN (${list})`)
    for (const rec of q.records) result.set(rec.Id, rec.Name)
  } catch {
    // No access to Group, or none of the remaining ids are Groups either —
    // leave them as raw Ids, same graceful degradation as an unresolvable
    // User id.
  }
  return result
}
