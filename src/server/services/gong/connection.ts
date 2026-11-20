import {
  DEFAULT_GONG_API_BASE_URL,
  GONG_CAPABILITY_KEYS,
  GONG_CAPABILITY_SCOPES,
  GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT,
  GONG_WEBHOOK_PATH,
  REQUIRED_GONG_CAPABILITIES,
  normalizeGongApiBaseUrl,
  type GongCapability,
  type GongCapabilityKey,
  type GongCapabilityReport,
  type GongConnectionSummary,
  type GongWorkspace,
} from '../../../shared/gong.js'
import { getPublicBaseUrl } from '../config/integrations.js'
import { GongError, gongRequest, type GongResponse } from './client.js'
import {
  clearGongConfig,
  getGongConfig,
  getGongStoredView,
  saveGongCheck,
  updateGongSettings,
  type GongConfig,
  type GongSettingsPatch,
} from './config.js'
import { clearGongUsers, getGongUserMatchSummary } from './users.js'
import { clearGongCallIndex } from './calls.js'
import { clearGongTranscripts } from './transcripts.js'

// What Admin → Integrations → Gong reads and writes (Gong plan, phase 1).
// Routes stay thin; the rules live here so they can be tested.

export const GONG_OAUTH_CALLBACK_PATH = '/auth/gong/callback'

export async function gongOAuthRedirectUri(): Promise<string | null> {
  const base = await getPublicBaseUrl()
  return base ? `${base}${GONG_OAUTH_CALLBACK_PATH}` : null
}

export async function getGongConnectionSummary(): Promise<GongConnectionSummary> {
  const [view, cfg, users, redirectUri, base] = await Promise.all([getGongStoredView(), getGongConfig(), getGongUserMatchSummary(), gongOAuthRedirectUri(), getPublicBaseUrl()])
  const authMethod = view?.authMethod ?? 'access_key'
  return {
    configured: cfg !== null,
    authMethod,
    apiBaseUrl: view?.apiBaseUrl ?? null,
    credentialHint: authMethod === 'access_key'
      ? (view?.accessKey ? view.accessKey.slice(-4) : null)
      : (view?.oauthClientId ? view.oauthClientId.slice(-4) : null),
    oauth: {
      clientId: view?.oauthClientId ?? null,
      clientSecretOnFile: view?.hasOAuthClientSecret ?? false,
      connected: view?.oauthConnected ?? false,
      connectedAt: view?.oauthConnectedAt ?? null,
      redirectUri,
    },
    workspaceIds: view?.workspaceIds ?? [],
    transcriptCacheDays: view?.transcriptCacheDays ?? GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT,
    lastCheck: cfg ? (view?.lastCheck ?? null) : null,
    users,
    // Auto-link only runs on a working Gong connection, so it reads as off
    // without one.
    autoLink: cfg !== null && (view?.autoLink ?? true),
    webhook: {
      publicKeyOnFile: view?.webhookPublicKeyOnFile ?? false,
      url: base ? `${base}${GONG_WEBHOOK_PATH}` : null,
    },
  }
}

export type SaveGongSettingsResult = { ok: true } | { ok: false; status: 400 | 502; error: string }

// Saves the card. A new access key pair is tried against Gong first and is
// never stored if Gong refuses it; an OAuth app is checked when the admin
// clicks Connect instead (it needs the browser round trip).
export async function saveGongSettings(patch: GongSettingsPatch): Promise<SaveGongSettingsResult> {
  if (patch.apiBaseUrl !== undefined && !normalizeGongApiBaseUrl(patch.apiBaseUrl)) {
    return { ok: false, status: 400, error: 'errors.gong.base_url_invalid' }
  }
  const view = await getGongStoredView()
  const method = patch.authMethod ?? view?.authMethod ?? 'access_key'
  if (method === 'access_key' && (patch.accessKey || patch.accessKeySecret)) {
    const accessKey = patch.accessKey || view?.accessKey
    if (!accessKey) return { ok: false, status: 400, error: 'errors.gong.access_key_required' }
    // An unchanged secret can't be re-read here (only "on file" is known), so
    // a new key needs its secret alongside it.
    if (!patch.accessKeySecret) return { ok: false, status: 400, error: 'errors.gong.access_key_secret_required' }
    const apiBaseUrl = normalizeGongApiBaseUrl(patch.apiBaseUrl ?? view?.apiBaseUrl ?? DEFAULT_GONG_API_BASE_URL) ?? DEFAULT_GONG_API_BASE_URL
    try {
      await probeCredentials({
        authMethod: 'access_key',
        apiBaseUrl,
        credentials: { method: 'access_key', accessKey, accessKeySecret: patch.accessKeySecret },
        workspaceIds: [],
        transcriptCacheDays: GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT,
        lastCheck: null,
        autoLink: true,
        webhookPublicKeyPem: null,
      })
    } catch (err) {
      const code = err instanceof GongError ? err.code : 'errors.gong.unreachable'
      return { ok: false, status: code === 'errors.gong.unauthorized' ? 400 : 502, error: code }
    }
  }
  // Host, workspaces and cache days can be saved before any credential.
  if (method === 'oauth' && !patch.oauthClientId && !view?.oauthClientId) {
    return { ok: false, status: 400, error: 'errors.gong.oauth_client_required' }
  }
  try {
    await updateGongSettings(patch)
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : 'errors.gong.base_url_invalid' }
  }
  return { ok: true }
}

// Proves Gong accepts the credentials: any answer but 401 does (a 403 means
// the key works but lacks the users scope, which the check reports).
async function probeCredentials(config: GongConfig): Promise<void> {
  await gongRequest('/v2/users', { config, allowStatuses: [403, 404] })
}

function scopeStatus(res: GongResponse): 'ok' | 'missing' {
  return res.status === 403 ? 'missing' : 'ok'
}

// One probe per capability. Gong answers 404 when a call listing finds no
// calls in the window, which still proves the scope.
export async function probeGongCapability(key: GongCapabilityKey, now: Date = new Date()): Promise<'ok' | 'missing'> {
  const window = { fromDateTime: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), toDateTime: now.toISOString() }
  switch (key) {
    case 'users':
      return scopeStatus(await gongRequest('/v2/users', { allowStatuses: [403, 404] }))
    case 'workspaces':
      return scopeStatus(await gongRequest('/v2/workspaces', { allowStatuses: [403, 404] }))
    case 'calls':
      return scopeStatus(await gongRequest('/v2/calls/extensive', { method: 'POST', body: { filter: window }, allowStatuses: [403, 404] }))
    case 'transcripts':
      return scopeStatus(await gongRequest('/v2/calls/transcript', { method: 'POST', body: { filter: window }, allowStatuses: [403, 404] }))
  }
}

export function buildGongCapabilityReport(statuses: Partial<Record<GongCapabilityKey, GongCapability['status']>>, now: Date = new Date()): GongCapabilityReport {
  const capabilities: GongCapability[] = GONG_CAPABILITY_KEYS.map((key) => ({
    key,
    scope: GONG_CAPABILITY_SCOPES[key],
    required: REQUIRED_GONG_CAPABILITIES.has(key),
    status: statuses[key] ?? 'unknown',
  }))
  return {
    checkedAt: now.toISOString(),
    ready: capabilities.every((c) => !c.required || c.status === 'ok'),
    capabilities,
  }
}

// Runs every probe with the saved connection and keeps the result. A refused
// credential (401) or an unreachable Gong stops the check with that error;
// a probe that fails any other way is reported as unknown.
export async function runGongCapabilityCheck(): Promise<GongCapabilityReport> {
  if (!(await getGongConfig())) throw new GongError('errors.gong.not_configured')
  const statuses: Partial<Record<GongCapabilityKey, GongCapability['status']>> = {}
  for (const key of GONG_CAPABILITY_KEYS) {
    try {
      statuses[key] = await probeGongCapability(key)
    } catch (err) {
      if (err instanceof GongError && (err.code === 'errors.gong.unauthorized' || err.code === 'errors.gong.unreachable')) throw err
      statuses[key] = 'unknown'
    }
  }
  const report = buildGongCapabilityReport(statuses)
  await saveGongCheck(report)
  return report
}

export function pickGongWorkspaces(body: unknown): GongWorkspace[] {
  if (!body || typeof body !== 'object') return []
  const list = (body as Record<string, unknown>)['workspaces']
  if (!Array.isArray(list)) return []
  const out: GongWorkspace[] = []
  for (const w of list) {
    if (!w || typeof w !== 'object') continue
    const r = w as Record<string, unknown>
    const id = typeof r['id'] === 'number' ? String(r['id']) : typeof r['id'] === 'string' ? r['id'] : ''
    if (!id) continue
    out.push({ id, name: typeof r['name'] === 'string' && r['name'] !== '' ? r['name'] : id })
  }
  return out
}

export async function listGongWorkspaces(): Promise<GongWorkspace[]> {
  const res = await gongRequest('/v2/workspaces')
  return pickGongWorkspaces(res.body)
}

export async function removeGongConnection(): Promise<void> {
  await clearGongConfig()
  await clearGongUsers()
  // The index and cached transcripts came from this tenant. Activity links
  // keep their snapshot so a reconnect to the same tenant finds them again.
  await clearGongCallIndex()
  await clearGongTranscripts()
}
