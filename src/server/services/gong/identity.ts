import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { gongUsers, users } from '../../../../drizzle/schema.js'
import { textArray } from './sqlArray.js'

// Who a person is on Gong calls: their own email, plus their Gong user (the
// one an App Admin picked, else the active Gong user with the same email) and
// that Gong user's email. A party on a call matches on any of these.
export interface GongIdentity {
  emails: string[]
  gongUserIds: string[]
}

export async function getGongIdentities(userIds: string[]): Promise<Map<string, GongIdentity>> {
  const out = new Map<string, GongIdentity>()
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return out
  const rows = await db.select({ id: users.id, email: users.email, gongUserId: users.gongUserId }).from(users).where(inArray(users.id, ids))
  const emails = rows.map((r) => r.email.toLowerCase())
  const manualIds = rows.map((r) => r.gongUserId).filter((g): g is string => !!g)
  const gong = emails.length + manualIds.length === 0 ? [] : await db
    .select({ id: gongUsers.id, email: gongUsers.email, active: gongUsers.active })
    .from(gongUsers)
    .where(sql`${gongUsers.id} = ANY(${textArray(manualIds)}) OR lower(${gongUsers.email}) = ANY(${textArray(emails)})`)
  for (const r of rows) {
    const email = r.email.toLowerCase()
    const matched = r.gongUserId
      ? gong.find((g) => g.id === r.gongUserId)
      : gong.find((g) => g.active && g.email?.toLowerCase() === email)
    const identity: GongIdentity = { emails: [email], gongUserIds: [] }
    if (r.gongUserId) identity.gongUserIds.push(r.gongUserId)
    if (matched) {
      if (!identity.gongUserIds.includes(matched.id)) identity.gongUserIds.push(matched.id)
      const gEmail = matched.email?.toLowerCase()
      if (gEmail && !identity.emails.includes(gEmail)) identity.emails.push(gEmail)
    }
    out.set(r.id, identity)
  }
  return out
}

export function mergeIdentities(...list: Array<GongIdentity | undefined>): GongIdentity {
  const emails = new Set<string>()
  const gongUserIds = new Set<string>()
  for (const i of list) {
    if (!i) continue
    i.emails.forEach((e) => emails.add(e))
    i.gongUserIds.forEach((g) => gongUserIds.add(g))
  }
  return { emails: [...emails], gongUserIds: [...gongUserIds] }
}

export function isOnCall(identity: GongIdentity, call: { partyEmails: string[]; partyUserIds: string[] }): boolean {
  return call.partyEmails.some((e) => identity.emails.includes(e)) || call.partyUserIds.some((u) => identity.gongUserIds.includes(u))
}

// The SQL form of isOnCall, for queries over gong_calls.
export function onCallCondition(identity: GongIdentity) {
  return sql`(gong_calls.party_emails && ${textArray(identity.emails)} OR gong_calls.party_user_ids && ${textArray(identity.gongUserIds)})`
}

// For the Gong card: set or clear a user's manual Gong link.
export async function setUserGongLink(userId: string, gongUserId: string | null): Promise<boolean> {
  if (gongUserId) {
    const [g] = await db.select({ id: gongUsers.id }).from(gongUsers).where(eq(gongUsers.id, gongUserId)).limit(1)
    if (!g) return false
  }
  const updated = await db.update(users).set({ gongUserId }).where(eq(users.id, userId)).returning({ id: users.id })
  return updated.length > 0
}
