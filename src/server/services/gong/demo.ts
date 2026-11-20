import { sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '../../db/index.js'
import { gongCalls } from '../../../../drizzle/schema.js'
import { getDemoTeamId } from '../demo/ids.js'
import { isGongConfigured } from './config.js'

// Demo Gong data (v1.459.0). The Demo Data generator seeds sample Gong calls,
// their transcripts and AI Notes on the demo team's activities, so the
// Transcripts tab, the AI Notes tab and My Notes → AI can be shown without a
// Gong connection. Demo call ids start with this prefix; real Gong call ids
// are numeric, so the two never collide.
//
// The rules that keep demo and real data apart:
// - a demo-team activity only ever sees demo calls, and a real activity
//   only ever sees real ones (suggestions, search, linking);
// - a demo transcript is read from the cache and never fetched from Gong;
// - housekeeping culls and a Gong disconnect leave demo rows alone (Remove
//   Demo Data deletes them);
// - auto-linking never touches demo calls or demo-team activities.

export const DEMO_GONG_CALL_PREFIX = 'demo-gong-'
export const DEMO_GONG_CALL_ID_RX = /^demo-gong-\d{1,12}$/

export function isDemoGongCallId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DEMO_GONG_CALL_PREFIX)
}

export function notDemoGongCall(col: AnyPgColumn): SQL {
  return sql`${col} NOT LIKE ${DEMO_GONG_CALL_PREFIX + '%'}`
}

export function onlyDemoGongCalls(col: AnyPgColumn): SQL {
  return sql`${col} LIKE ${DEMO_GONG_CALL_PREFIX + '%'}`
}

export async function hasDemoGongCalls(): Promise<boolean> {
  const [row] = await db.select({ id: gongCalls.id }).from(gongCalls).where(onlyDemoGongCalls(gongCalls.id)).limit(1)
  return !!row
}

// Whether Gong features can show at all: a real connection, or demo calls.
export async function isGongAvailable(): Promise<boolean> {
  if (await isGongConfigured()) return true
  return hasDemoGongCalls()
}

export interface GongTeamReadiness {
  // Gong features work for this team's activities.
  ready: boolean
  // The team is the demo team: its activities use demo calls only.
  demo: boolean
}

export async function gongReadinessForTeam(teamId: string): Promise<GongTeamReadiness> {
  const demoTeamId = await getDemoTeamId()
  if (demoTeamId && teamId === demoTeamId) return { ready: await hasDemoGongCalls(), demo: true }
  return { ready: await isGongConfigured(), demo: false }
}

// The gong_calls filter for one activity: demo calls for a demo activity,
// real calls otherwise.
export function callScopeFor(demo: boolean): SQL {
  return demo ? onlyDemoGongCalls(gongCalls.id) : notDemoGongCall(gongCalls.id)
}
