// Gong connection (Gong plan, phase 1): types and limits shared by the server
// and Admin → Integrations → Gong. Gong has no per-user sign-in: one
// org-wide credential reads the whole tenant, so ImpactIQ decides who sees
// what. Two ways to connect:
//   - access_key: an Access Key + Access Key Secret a Gong tech admin
//     creates under Company settings → API (HTTP Basic). The default.
//   - oauth: an OAuth app the customer registers in Gong; a Gong tech admin
//     authorizes it once, and Gong returns the tenant's API host.

export const GONG_AUTH_METHODS = ['access_key', 'oauth'] as const
export type GongAuthMethod = typeof GONG_AUTH_METHODS[number]

export const DEFAULT_GONG_API_BASE_URL = 'https://api.gong.io'

// What the connection check probes, in display order, and the Gong scope
// each one needs (an access key carries every scope; an OAuth app only the
// ones it was registered with).
export const GONG_CAPABILITY_KEYS = ['users', 'workspaces', 'calls', 'transcripts'] as const
export type GongCapabilityKey = typeof GONG_CAPABILITY_KEYS[number]

export const GONG_CAPABILITY_SCOPES: Readonly<Record<GongCapabilityKey, string>> = {
  users: 'api:users:read',
  workspaces: 'api:workspaces:read',
  calls: 'api:calls:read:extensive',
  transcripts: 'api:calls:read:transcript',
}

// Workspaces only matter on a tenant with more than one; the rest are needed.
export const REQUIRED_GONG_CAPABILITIES: ReadonlySet<GongCapabilityKey> = new Set(['users', 'calls', 'transcripts'])

export const GONG_OAUTH_SCOPES: readonly string[] = GONG_CAPABILITY_KEYS.map((k) => GONG_CAPABILITY_SCOPES[k])

export type GongCapabilityStatus = 'ok' | 'missing' | 'unknown'

export interface GongCapability {
  key: GongCapabilityKey
  scope: string
  required: boolean
  status: GongCapabilityStatus
}

export interface GongCapabilityReport {
  checkedAt: string
  ready: boolean
  capabilities: GongCapability[]
}

// How long a fetched transcript is kept (phase 2 fills the cache). App Admin
// sets it on the Gong card.
export const GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT = 30
export const GONG_TRANSCRIPT_CACHE_DAYS_MIN = 1
export const GONG_TRANSCRIPT_CACHE_DAYS_MAX = 365

export function clampTranscriptCacheDays(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT
  return Math.min(GONG_TRANSCRIPT_CACHE_DAYS_MAX, Math.max(GONG_TRANSCRIPT_CACHE_DAYS_MIN, Math.round(n)))
}

// Gong's API lives on a per-tenant host under gong.io (api.gong.io, or
// us-12345.api.gong.io / <company>.api.gong.io). Anything else is refused, so
// a saved base URL can't point the server at another host.
export function normalizeGongApiBaseUrl(raw: string): string | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.search || url.hash) return null
  const host = url.hostname.toLowerCase()
  if (host !== 'api.gong.io' && !/^[a-z0-9-]+\.api\.gong\.io$/.test(host)) return null
  return `https://${host}`
}

export interface GongWorkspace {
  id: string
  name: string
}

export interface GongUserMatchSummary {
  gongUsers: number
  lastSyncedAt: string | null
  matchedUsers: number
  unmatchedUsers: Array<{ id: string; displayName: string; email: string }>
  // Users an App Admin linked to a Gong user by hand (v1.453.0).
  manualLinks: Array<{ id: string; displayName: string; email: string; gongUserId: string; gongUserName: string | null }>
}

export interface GongUserOption {
  id: string
  name: string
  email: string | null
}

export interface GongTeamTranscriptAccess {
  teamId: string
  name: string
  leadersCanRead: boolean
}

export interface GongConnectionSummary {
  configured: boolean
  authMethod: GongAuthMethod
  apiBaseUrl: string | null
  // Last 4 characters of the access key, or of the OAuth client id.
  credentialHint: string | null
  oauth: {
    clientId: string | null
    clientSecretOnFile: boolean
    connected: boolean
    connectedAt: string | null
    redirectUri: string | null
  }
  workspaceIds: string[]
  transcriptCacheDays: number
  lastCheck: GongCapabilityReport | null
  users: GongUserMatchSummary
  // v1.456.0 (phase 3)
  autoLink: boolean
  webhook: {
    publicKeyOnFile: boolean
    // Where Gong's "Fire webhook" rule posts; null until the app's public
    // URL is set.
    url: string | null
  }
}

// ── Phase 2: calls, links and transcripts ────────────────────────────────

// Suggestions need at least this score; at most this many are shown.
export const GONG_SUGGESTION_MIN_SCORE = 40
export const GONG_SUGGESTION_LIMIT = 5
// How far back the call index reaches, and so how far back search can find.
export const GONG_INDEX_LOOKBACK_DAYS = 365

export type GongLinkMethod = 'manual' | 'calendar_event' | 'auto'

// ── Phase 3: auto-linking and the Gong webhook ───────────────────────────

// Auto-link needs one candidate at or above this score, and no second
// candidate at or above GONG_SUGGESTION_MIN_SCORE. The same calendar meeting
// always links.
export const GONG_AUTO_LINK_MIN_SCORE = 85
// How far back the auto-link job looks for activities with no call linked.
export const GONG_AUTO_LINK_LOOKBACK_DAYS = 14
export const GONG_WEBHOOK_PATH = '/api/webhooks/gong'

// GET /api/gong/week: which of the caller's meetings and activities in a
// range have a Gong recording.
export interface GongWeekMarks {
  // Outlook event ids with a matching Gong call.
  recordedEvents: string[]
  // The caller's activities with at least one linked call.
  linkedActivities: string[]
}

export interface GongParty {
  name: string | null
  email: string | null
  title: string | null
  affiliation: 'internal' | 'external' | 'unknown'
  speakerId: string | null
  gongUserId: string | null
}

export type GongMatchReason =
  | { kind: 'same_meeting' }
  | { kind: 'starts_close'; minutes: number }
  | { kind: 'owner_on_call' }
  | { kind: 'attendees'; count: number }
  | { kind: 'same_record' }
  | { kind: 'similar_title' }

export interface GongCallSummary {
  id: string
  title: string | null
  url: string | null
  startedAt: string
  durationS: number | null
  hostName: string | null
  partyCount: number
}

export interface GongSuggestion extends GongCallSummary {
  score: number
  reasons: GongMatchReason[]
}

export interface LinkedGongCall {
  id: string
  title: string | null
  url: string | null
  startedAt: string | null
  durationS: number | null
  linkMethod: GongLinkMethod
  linkedAt: string
  // Whether the viewer may read this call's transcript.
  canRead: boolean
}

export interface GongActivityCalls {
  calls: LinkedGongCall[]
  // Owner or App Admin: may link and unlink.
  canLink: boolean
}

export interface GongTranscriptSentence {
  start: number // ms from the start of the call
  text: string
}

export interface GongTranscriptMonologue {
  speakerId: string | null
  topic: string | null
  sentences: GongTranscriptSentence[]
}

export interface GongTranscriptView {
  callId: string
  url: string | null
  parties: Array<GongParty & { isImpactIqUser: boolean }>
  monologues: GongTranscriptMonologue[]
  fetchedAt: string
}

// A Gong call URL opened at a second of the recording.
export function gongCallUrlAt(url: string | null, ms: number): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    u.searchParams.set('t', String(Math.max(0, Math.floor(ms / 1000))))
    return u.toString()
  } catch {
    return null
  }
}

export function formatTranscriptOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
