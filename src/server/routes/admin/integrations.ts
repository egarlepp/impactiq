import { Router, type Request } from 'express'
import { db } from '../../db/index.js'
import { teamMembers, users } from '../../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import { requireAppAdmin, requireDefaultAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { getAdminSfConnection } from '../../services/salesforce/client.js'
import { LOGIN_LOGO_SIZE_MIN, LOGIN_LOGO_SIZE_MAX } from '../../../shared/loginLogoSize.js'
import { emailRuleSupportsSlackDm } from '../../../shared/emailRuleSlack.js'
import {
  getIntegrationConfigSummary,
  saveSfIntegrationConfig,
  saveMsIntegrationConfig,
  saveOktaIntegrationConfig,
  saveAzureSsoIntegrationConfig,
  saveSmtpIntegrationConfig,
  getOktaIntegrationConfig,
  getSfIntegrationConfig,
  getMsIntegrationConfig,
  getAzureSsoIntegrationConfig,
  getEmailIntegrationConfig,
  clearSfIntegrationConfig,
  clearMsIntegrationConfig,
  clearOktaIntegrationConfig,
  clearAzureSsoIntegrationConfig,
  clearSmtpIntegrationConfig,
  isOutlookAppOnlyEnabled,
  setOutlookAppOnlyEnabled,
  getOutlookSyncSettings,
  setOutlookSyncSettings,
  normalizeDomains,
  getSfInternalDomains,
  setSfInternalDomains,
  isOktaAllowUnverifiedEmail,
  setOktaAllowUnverifiedEmail,
} from '../../services/config/integrations.js'
import { z } from 'zod'
import { assertPublicHttpsUrl, assertSalesforceLoginUrl } from '../../services/net/ssrfGuard.js'
import { safeFetch } from '../../services/net/safeFetch.js'
import { htmlToText } from '../../services/email/rule-sender.js'
import { validateLogoDataUrl } from './themes.js'
import { definedEntries } from '../../lib/records.js'
import { microsoftLoginUrl } from '../../services/auth/microsoftLogin.js'

export const integrationsRoutes = Router()

// --- Integration credential config (DB-backed, overrides env vars at runtime) ---

integrationsRoutes.get('/integrations/config', requireAppAdmin, (_req, res) => {
  res.json({ data: getIntegrationConfigSummary(), error: null, meta: {} })
})

// Secrets are optional on edit: when omitted (or empty), the server reuses the
// already-stored value so the admin doesn't have to re-type it just to change
// other fields.
const SfConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url(),
  loginUrl: z.string().url().optional().default('https://login.salesforce.com'),
})

const MsConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  tenantId: z.string().min(1),
})

const OktaConfigSchema = z.object({
  domain: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url(),
})

const AzureSsoConfigSchema = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url(),
  allowJit: z.boolean().default(false),
})

const EmailConfigSchema = z.discriminatedUnion('authMethod', [
  z.object({
    authMethod: z.literal('smtp'),
    host: z.string().min(1),
    port: z.number().int().positive(),
    username: z.string().min(1),
    password: z.string().optional(),
    fromAddress: z.string().email(),
    replyToAddress: z.string().email().nullable().optional().transform((v) => v ?? null),
    secure: z.boolean().default(false),
  }),
  z.object({
    authMethod: z.literal('graph_app'),
    tenantId: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    senderMailbox: z.string().min(1),
    fromAddress: z.string().email(),
    replyToAddress: z.string().email().nullable().optional().transform((v) => v ?? null),
  }),
])

integrationsRoutes.put('/integrations/config/salesforce', requireAppAdmin, async (req, res) => {
  const parsed = SfConfigSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (F-01, pentest 2026-09): loginUrl was previously stored
  // with no host restriction, letting an admin point it at an
  // attacker-controlled server — used later both as a blind SSRF probe (the
  // test endpoint below) and as the token-exchange host, leaking the
  // Salesforce Connected App client_secret. Reject at save time so a bad
  // value never reaches storage.
  try {
    await assertSalesforceLoginUrl(parsed.data.loginUrl)
  } catch (err) {
    // Raw diagnostic message, not an i18n key — matches this file's existing
    // convention for dynamic, technical, App-Admin-only config errors (e.g.
    // the sf-field-mappings insert-failure message below).
    res.status(400).json({ data: null, error: `Invalid Salesforce Login URL: ${err instanceof Error ? err.message : String(err)}`, meta: {} })
    return
  }
  const existing = getSfIntegrationConfig()
  const clientSecret = parsed.data.clientSecret || existing?.clientSecret
  if (!clientSecret) { res.status(400).json({ data: null, error: 'errors.validation.client_secret_required', meta: {} }); return }
  await saveSfIntegrationConfig({ ...parsed.data, clientSecret })
  await logAudit(req, { action: 'integration.salesforce.save', targetType: 'integration', targetId: 'salesforce' })
  res.json({ data: getIntegrationConfigSummary().salesforce, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/config/microsoft', requireAppAdmin, async (req, res) => {
  const parsed = MsConfigSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const existing = getMsIntegrationConfig()
  const clientSecret = parsed.data.clientSecret || existing?.clientSecret
  if (!clientSecret) { res.status(400).json({ data: null, error: 'errors.validation.client_secret_required', meta: {} }); return }
  await saveMsIntegrationConfig({ ...parsed.data, clientSecret })
  res.json({ data: getIntegrationConfigSummary().microsoft, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/config/okta', requireAppAdmin, async (req, res) => {
  const parsed = OktaConfigSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (same class as F-01/F-02, pentest 2026-09): domain was
  // stored with no validation and later used for an unguarded outbound
  // fetch (the test endpoint below) — same SSRF shape as loginUrl/endpoint,
  // just not individually tested by the report. Okta supports fully custom
  // domains, so this uses the generic public-HTTPS-only guard rather than a
  // host-suffix allowlist (which would break a legitimate custom domain).
  try {
    await assertPublicHttpsUrl(`${normalizeOktaHost(parsed.data.domain)}/.well-known/openid-configuration`)
  } catch (err) {
    res.status(400).json({ data: null, error: `Invalid Okta domain: ${err instanceof Error ? err.message : String(err)}`, meta: {} })
    return
  }
  const existing = getOktaIntegrationConfig()
  const clientSecret = parsed.data.clientSecret || existing?.clientSecret
  if (!clientSecret) { res.status(400).json({ data: null, error: 'errors.validation.client_secret_required', meta: {} }); return }
  await saveOktaIntegrationConfig({ ...parsed.data, clientSecret })
  res.json({ data: getIntegrationConfigSummary().okta, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/config/azure_sso', requireAppAdmin, async (req, res) => {
  const parsed = AzureSsoConfigSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const existing = getAzureSsoIntegrationConfig()
  const clientSecret = parsed.data.clientSecret || existing?.clientSecret
  if (!clientSecret) { res.status(400).json({ data: null, error: 'errors.validation.client_secret_required', meta: {} }); return }
  await saveAzureSsoIntegrationConfig({
    tenantId: parsed.data.tenantId,
    clientId: parsed.data.clientId,
    clientSecret,
    redirectUri: parsed.data.redirectUri,
    allowJit: parsed.data.allowJit,
  })
  await logAudit(req, { action: 'integration.azure_sso.save', targetType: 'integration', targetId: 'azure_sso' })
  res.json({ data: getIntegrationConfigSummary().azureSso, error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/config/azure_sso', requireAppAdmin, async (req, res) => {
  await clearAzureSsoIntegrationConfig()
  await logAudit(req, { action: 'integration.azure_sso.clear', targetType: 'integration', targetId: 'azure_sso' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/config/salesforce', requireAppAdmin, async (_req, res) => {
  await clearSfIntegrationConfig()
  res.json({ data: { ok: true }, error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/config/microsoft', requireAppAdmin, async (_req, res) => {
  await clearMsIntegrationConfig()
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// Global rate limiter config (Admin → Integrations → Rate Limiting).
// meta.request shows what this request looked like on arrival, so the admin
// can check the proxy count: the X-Forwarded-For chain the app received and
// the client IP it worked out from it.
function requestSeen(req: Request): { ip: string | null; forwardedFor: string | null; proxyHeaderSeen: boolean } {
  const xff = req.headers['x-forwarded-for']
  const forwardedFor = typeof xff === 'string' ? xff.slice(0, 500) : Array.isArray(xff) ? xff.join(', ').slice(0, 500) : null
  return { ip: req.ip ?? null, forwardedFor, proxyHeaderSeen: forwardedFor !== null }
}

integrationsRoutes.get('/rate-limit', requireAppAdmin, async (req, res) => {
  const { getRateLimitSettings, trustedProxyHopsFromEnv } = await import('../../services/config/rate-limit-config.js')
  res.json({ data: getRateLimitSettings(), error: null, meta: { proxyHopsFromEnv: trustedProxyHopsFromEnv(), request: requestSeen(req) } })
})

integrationsRoutes.put('/rate-limit', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    enabled: z.boolean(),
    windowSeconds: z.number().int().min(10).max(3600),
    max: z.number().int().min(1).max(1_000_000),
    trustedProxyHops: z.number().int().min(0).max(3),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { saveRateLimitSettings, trustedProxyHopsFromEnv } = await import('../../services/config/rate-limit-config.js')
  const saved = await saveRateLimitSettings(parsed.data)
  await logAudit(req, { action: 'integration.rate_limit.save', targetType: 'integration', targetId: 'rate_limit', meta: { ...saved } })
  res.json({ data: saved, error: null, meta: { proxyHopsFromEnv: trustedProxyHopsFromEnv(), request: requestSeen(req) } })
})

integrationsRoutes.get('/integrations/outlook-app-only', requireAppAdmin, async (_req, res) => {
  const enabled = await isOutlookAppOnlyEnabled()
  res.json({ data: { enabled }, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/outlook-app-only', requireAppAdmin, async (req, res) => {
  const schema = z.object({ enabled: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await setOutlookAppOnlyEnabled(parsed.data.enabled)
  res.json({ data: { enabled: parsed.data.enabled }, error: null, meta: {} })
})

integrationsRoutes.get('/integrations/outlook-sync', requireAppAdmin, async (_req, res) => {
  const settings = await getOutlookSyncSettings()
  res.json({ data: settings, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/outlook-sync', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    forwardDays: z.number().int().min(0).max(90),
    retentionDays: z.number().int().min(30).max(3650),
    internalEmailDomains: z.union([z.string(), z.array(z.string())]).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const settings = { forwardDays: parsed.data.forwardDays, retentionDays: parsed.data.retentionDays, internalEmailDomains: normalizeDomains(parsed.data.internalEmailDomains) }
  await setOutlookSyncSettings(settings)
  res.json({ data: settings, error: null, meta: {} })
})

integrationsRoutes.get('/integrations/okta-allow-unverified-email', requireAppAdmin, async (_req, res) => {
  const enabled = await isOktaAllowUnverifiedEmail()
  res.json({ data: { enabled }, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/okta-allow-unverified-email', requireAppAdmin, async (req, res) => {
  const schema = z.object({ enabled: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await setOktaAllowUnverifiedEmail(parsed.data.enabled)
  res.json({ data: { enabled: parsed.data.enabled }, error: null, meta: {} })
})

// POST /api/admin/activities/import { teamId, csv, dryRun? }
// Bulk import for a whole team. CSV may include a user_email column; each row
// is assigned to the matching team member. Requires app-admin OR team-admin
// on the target team.
integrationsRoutes.post('/activities/import', async (req, res) => {
  const parsed = z.object({ teamId: z.string().uuid(), csv: z.string().min(1), dryRun: z.boolean().optional() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  const callerId = req.user!.id
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  let allowed = !!caller?.isAppAdmin
  if (!allowed) {
    const [m] = await db.select({ role: teamMembers.role }).from(teamMembers)
      .where(and(eq(teamMembers.userId, callerId), eq(teamMembers.teamId, parsed.data.teamId))).limit(1)
    allowed = m?.role === 'admin' || m?.role === 'team_admin'
  }
  if (!allowed) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }

  const { importActivitiesFromCsv } = await import('../../services/activities/csvImport.js')
  const result = await importActivitiesFromCsv(parsed.data.csv, {
    teamId: parsed.data.teamId,
    defaultUserId: callerId,
    allowUserEmailColumn: true,
    dryRun: parsed.data.dryRun ?? false,
  })
  if (!parsed.data.dryRun && result.summary.inserted > 0) {
    await logAudit(req, { action: 'user.update', targetType: 'activities.import', targetId: parsed.data.teamId, meta: { summary: result.summary } })
  }
  res.json({ data: result, error: null, meta: {} })
})

// --- Slack integration ---
integrationsRoutes.get('/integrations/slack', requireAppAdmin, async (_req, res) => {
  const { getSlackConfigSummary } = await import('../../services/slack/client.js')
  res.json({ data: await getSlackConfigSummary(), error: null, meta: {} })
})

integrationsRoutes.put('/integrations/slack', requireAppAdmin, async (req, res) => {
  const schema = z.object({ botToken: z.string().min(20), workspaceUrl: z.string().url().nullable().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { setSlackConfig } = await import('../../services/slack/client.js')
  await setSlackConfig(parsed.data.botToken, parsed.data.workspaceUrl ?? null)
  await logAudit(req, { action: 'integration.slack.save', targetType: 'integration', targetId: 'slack' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/slack', requireAppAdmin, async (req, res) => {
  const { clearSlackConfig } = await import('../../services/slack/client.js')
  await clearSlackConfig()
  await logAudit(req, { action: 'integration.slack.clear', targetType: 'integration', targetId: 'slack' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

integrationsRoutes.post('/integrations/slack/sync-users', requireAppAdmin, async (req, res) => {
  const { syncSlackUsers } = await import('../../services/slack/client.js')
  try {
    const results = await syncSlackUsers()
    const linked = results.filter((r) => r.status === 'linked').length
    const unlinked = results.filter((r) => r.status === 'unlinked').length
    res.json({ data: { results, linked, unlinked }, error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof Error ? err.message : 'Slack sync failed', meta: {} })
  }
})

// --- App Updates (v1.332.0, Phase 1: read-only check + info) ---
// Deliberately host-independent — no Dokploy/Docker assumption, see
// CLAUDE.md. Viewing is App-Admin-only (requireAppAdmin — matches every
// other integration status/summary read); every ACTION — triggering a live
// check, saving or clearing the GitHub PAT — is gated to the one designated
// `users.is_default_admin` account (requireDefaultAdmin), per the explicit
// product decision that App Admins may look but only the default admin may
// act. See rbac.ts's comment for the rationale.
integrationsRoutes.get('/updates/status', requireAppAdmin, async (_req, res) => {
  const { getCachedUpdateStatus } = await import('../../services/updates/checkForUpdates.js')
  res.json({ data: await getCachedUpdateStatus(), error: null, meta: {} })
})

integrationsRoutes.post('/updates/check-now', requireDefaultAdmin, async (req, res) => {
  const { checkForUpdates } = await import('../../services/updates/checkForUpdates.js')
  const status = await checkForUpdates()
  await logAudit(req, { action: 'system_update.check_now', targetType: 'integration', targetId: 'github_updates', meta: { updateAvailable: status.updateAvailable, error: status.error } })
  res.json({ data: status, error: null, meta: {} })
})

integrationsRoutes.get('/updates/settings', requireAppAdmin, async (_req, res) => {
  const { getUpdateConfigSummary } = await import('../../services/updates/checkForUpdates.js')
  res.json({ data: await getUpdateConfigSummary(), error: null, meta: {} })
})

integrationsRoutes.put('/updates/settings', requireDefaultAdmin, async (req, res) => {
  const schema = z.object({ owner: z.string().min(1).max(200), repo: z.string().min(1).max(200), pat: z.string().min(20) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { setUpdateConfig } = await import('../../services/updates/checkForUpdates.js')
  await setUpdateConfig(parsed.data.owner, parsed.data.repo, parsed.data.pat)
  await logAudit(req, { action: 'system_update.settings_save', targetType: 'integration', targetId: 'github_updates', meta: { owner: parsed.data.owner, repo: parsed.data.repo } })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

integrationsRoutes.delete('/updates/settings', requireDefaultAdmin, async (req, res) => {
  const { clearUpdateConfig } = await import('../../services/updates/checkForUpdates.js')
  await clearUpdateConfig()
  await logAudit(req, { action: 'system_update.settings_clear', targetType: 'integration', targetId: 'github_updates' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// --- Maintenance window (v1.333.0, App Updates Phase 2) ---
// PUT/DELETE are default-admin-only (see rbac.ts) — scheduling a restart
// that will interrupt every signed-in user is the same "owner's call" tier
// as the GitHub PAT above. The GET is intentionally NOT here — it's
// registered near the top of this file, before the blanket admin gate,
// because every signed-in user (not just admins) needs to read it to render
// MaintenanceBanner.tsx.
integrationsRoutes.put('/maintenance-window', requireDefaultAdmin, async (req, res) => {
  const schema = z.object({ scheduledAt: z.string().datetime(), message: z.string().max(500).nullable().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const scheduledAt = new Date(parsed.data.scheduledAt)
  if (scheduledAt.getTime() <= Date.now()) {
    res.status(400).json({ data: null, error: 'errors.maintenance_window.must_be_future', meta: {} })
    return
  }
  const { scheduleMaintenanceWindow } = await import('../../services/updates/maintenanceWindow.js')
  const window = await scheduleMaintenanceWindow(scheduledAt, parsed.data.message ?? null, req.user!.id, req.user!.email)
  await logAudit(req, { action: 'system_update.maintenance_schedule', targetType: 'integration', targetId: 'maintenance_window', meta: { scheduledAt: window.scheduledAt } })
  res.json({ data: window, error: null, meta: {} })
})

integrationsRoutes.delete('/maintenance-window', requireDefaultAdmin, async (req, res) => {
  const { cancelMaintenanceWindow } = await import('../../services/updates/maintenanceWindow.js')
  await cancelMaintenanceWindow()
  await logAudit(req, { action: 'system_update.maintenance_cancel', targetType: 'integration', targetId: 'maintenance_window' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// v1.106.0: public base URL for hosted email images. Set once by an
// app admin; must resolve to the app externally (i.e. Outlook clients
// on recipient side can reach it). Falls back to APP_URL env var
// when the DB setting is empty.
integrationsRoutes.get('/integrations/public-base-url', requireAppAdmin, async (_req, res) => {
  const { getPublicBaseUrl } = await import('../../services/config/integrations.js')
  const url = await getPublicBaseUrl()
  res.json({ data: { url }, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/public-base-url', requireAppAdmin, async (req, res) => {
  const schema = z.object({ url: z.string().url().max(2048).nullable().or(z.literal('')) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { setPublicBaseUrl, getPublicBaseUrl } = await import('../../services/config/integrations.js')
  const clean = parsed.data.url ? parsed.data.url : null
  await setPublicBaseUrl(clean)
  res.json({ data: { url: await getPublicBaseUrl() }, error: null, meta: {} })
})

// Support contact email shown on pre-auth screens + the in-app header help
// icon — see services/config/integrations.ts's getSupportEmail/setSupportEmail.
integrationsRoutes.get('/integrations/support-email', requireAppAdmin, async (_req, res) => {
  const { getSupportEmail } = await import('../../services/config/integrations.js')
  res.json({ data: { email: await getSupportEmail() }, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/support-email', requireAppAdmin, async (req, res) => {
  const schema = z.object({ email: z.string().email().max(320).nullable().or(z.literal('')) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { setSupportEmail, getSupportEmail } = await import('../../services/config/integrations.js')
  const clean = parsed.data.email ? parsed.data.email : null
  await setSupportEmail(clean)
  res.json({ data: { email: await getSupportEmail() }, error: null, meta: {} })
})

// App-wide CRM feature switches (services/crm/features.ts). CRM-neutral:
// the same switches apply to Salesforce today and HubSpot later. Readable by
// any signed-in user via GET /api/crm/features; only an App Admin changes them.
integrationsRoutes.get('/integrations/crm-features', requireAppAdmin, async (_req, res) => {
  const { getCrmFeatures, getCrmFeatureAvailability } = await import('../../services/crm/features.js')
  // meta.availability: what the CRM can offer, so the card can say when a
  // switch is on but the HubSpot portal lacks the feature.
  res.json({ data: await getCrmFeatures(), error: null, meta: { availability: await getCrmFeatureAvailability() } })
})

integrationsRoutes.put('/integrations/crm-features', requireAppAdmin, async (req, res) => {
  const schema = z.object({ campaignsEnabled: z.boolean().optional(), leadsEnabled: z.boolean().optional(), hubspotCreateMeetings: z.boolean().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { getCrmFeatures, getCrmFeatureAvailability, setCrmFeatures } = await import('../../services/crm/features.js')
  const before = await getCrmFeatures()
  const patch: { campaignsEnabled?: boolean; leadsEnabled?: boolean; hubspotCreateMeetings?: boolean } = {}
  if (parsed.data.campaignsEnabled !== undefined) patch.campaignsEnabled = parsed.data.campaignsEnabled
  if (parsed.data.leadsEnabled !== undefined) patch.leadsEnabled = parsed.data.leadsEnabled
  if (parsed.data.hubspotCreateMeetings !== undefined) patch.hubspotCreateMeetings = parsed.data.hubspotCreateMeetings
  const after = await setCrmFeatures(patch)
  await logAudit(req, { action: 'integration.crm_features.update', targetType: 'integration', targetId: 'crm_features', meta: { before, after } })
  res.json({ data: after, error: null, meta: { availability: await getCrmFeatureAvailability() } })
})

// Which CRM this install uses (services/crm/providerLock.ts). App Admin
// only. A change to a different CRM is refused (409 provider_locked) once
// CRM-linked data exists; moving between that data's CRM and "none" is
// always allowed, since every saved link stays valid.
integrationsRoutes.get('/integrations/crm-provider', requireAppAdmin, async (_req, res) => {
  const { getCrmProviderState } = await import('../../services/crm/providerLock.js')
  res.json({ data: await getCrmProviderState(), error: null, meta: {} })
})

integrationsRoutes.put('/integrations/crm-provider', requireAppAdmin, async (req, res) => {
  const { CRM_PROVIDER_IDS } = await import('../../../shared/crmProvider.js')
  const parsed = z.object({ provider: z.enum(CRM_PROVIDER_IDS) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { changeCrmProvider, getCrmProviderState } = await import('../../services/crm/providerLock.js')
  const result = await changeCrmProvider(parsed.data.provider)
  if (!result.ok) {
    res.status(result.status).json({ data: null, error: result.error, meta: {} })
    return
  }
  if (result.before.provider !== result.after.provider) {
    await logAudit(req, { action: 'integration.crm_provider.update', targetType: 'integration', targetId: 'crm_provider', meta: { before: result.before, after: result.after } })
  }
  res.json({ data: await getCrmProviderState(), error: null, meta: {} })
})

// Where activities' Projects (Evaluations) come from, and CriteriaIQ as a
// secondary source (services/criteriaiq/evaluationSource.ts). App Admin only.
// The primary is locked once activities link to Projects, the same rule as
// the CRM choice; the secondary is never locked.
integrationsRoutes.get('/integrations/evaluation-source', requireAppAdmin, async (_req, res) => {
  const { getEvaluationSourceState } = await import('../../services/criteriaiq/evaluationSource.js')
  res.json({ data: await getEvaluationSourceState(), error: null, meta: {} })
})

integrationsRoutes.put('/integrations/evaluation-source', requireAppAdmin, async (req, res) => {
  const { EVALUATION_SOURCE_IDS } = await import('../../../shared/evaluationSource.js')
  const parsed = z.object({
    primary: z.enum(EVALUATION_SOURCE_IDS).optional(),
    criteriaiqSecondary: z.boolean().optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { changeEvaluationSource, getEvaluationSourceState } = await import('../../services/criteriaiq/evaluationSource.js')
  const patch: { primary?: (typeof EVALUATION_SOURCE_IDS)[number]; criteriaiqSecondary?: boolean } = {}
  if (parsed.data.primary !== undefined) patch.primary = parsed.data.primary
  if (parsed.data.criteriaiqSecondary !== undefined) patch.criteriaiqSecondary = parsed.data.criteriaiqSecondary
  const result = await changeEvaluationSource(patch)
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: {} }); return }
  if (result.before.primary !== result.after.primary || result.before.criteriaiqSecondary !== result.after.criteriaiqSecondary) {
    await logAudit(req, { action: 'integration.evaluation_source.update', targetType: 'integration', targetId: 'evaluation_source', meta: { before: result.before, after: result.after } })
  }
  res.json({ data: await getEvaluationSourceState(), error: null, meta: {} })
})

// CriteriaIQ connection (services/criteriaiq/config.ts + client.ts): base URL
// and an API key with CriteriaIQ's projects:read scope. The key is stored
// encrypted and only its last 4 characters are ever returned.
integrationsRoutes.get('/integrations/criteriaiq', requireAppAdmin, async (_req, res) => {
  const { getCriteriaIqConfigSummary } = await import('../../services/criteriaiq/config.js')
  res.json({ data: await getCriteriaIqConfigSummary(), error: null, meta: {} })
})

integrationsRoutes.put('/integrations/criteriaiq', requireAppAdmin, async (req, res) => {
  const parsed = z.object({
    baseUrl: z.string().url().max(2048),
    apiKey: z.string().min(16).max(512).nullable().optional(),
    allowPrivateNetwork: z.boolean().optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const allowPrivateNetwork = parsed.data.allowPrivateNetwork ?? false
  const { assertCriteriaIqUrl } = await import('../../services/net/ssrfGuard.js')
  const { normalizeBaseUrl, setCriteriaIqConfig, getCriteriaIqConfigSummary } = await import('../../services/criteriaiq/config.js')
  const baseUrl = normalizeBaseUrl(parsed.data.baseUrl)
  try {
    await assertCriteriaIqUrl(baseUrl, allowPrivateNetwork)
  } catch {
    res.status(400).json({ data: null, error: 'errors.criteriaiq.url_blocked', meta: {} })
    return
  }
  try {
    await setCriteriaIqConfig({ baseUrl, apiKey: parsed.data.apiKey ?? null, allowPrivateNetwork })
  } catch (err) {
    res.status(400).json({ data: null, error: err instanceof Error ? err.message : 'errors.criteriaiq.api_key_required', meta: {} })
    return
  }
  const { clearCriteriaIqCache } = await import('../../services/criteriaiq/client.js')
  clearCriteriaIqCache()
  await logAudit(req, { action: 'integration.criteriaiq.save', targetType: 'integration', targetId: 'criteriaiq', meta: { baseUrl, allowPrivateNetwork, keyChanged: !!parsed.data.apiKey } })
  res.json({ data: await getCriteriaIqConfigSummary(), error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/criteriaiq', requireAppAdmin, async (req, res) => {
  const { getEvaluationSourceSetting } = await import('../../services/criteriaiq/evaluationSource.js')
  const source = await getEvaluationSourceSetting()
  if (source.primary === 'criteriaiq' || source.criteriaiqSecondary) {
    res.status(409).json({ data: null, error: 'errors.criteriaiq.in_use', meta: {} })
    return
  }
  const { clearCriteriaIqConfig } = await import('../../services/criteriaiq/config.js')
  const { clearCriteriaIqCache } = await import('../../services/criteriaiq/client.js')
  await clearCriteriaIqConfig()
  clearCriteriaIqCache()
  await logAudit(req, { action: 'integration.criteriaiq.clear', targetType: 'integration', targetId: 'criteriaiq' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// Live refresh (v1.450.0, routes/criteriaiqWebhook.ts): a new signing secret
// for CriteriaIQ's webhook. Shown once in this response; afterwards only its
// last 4 characters. Calling it again rotates the secret, and the old one
// stops working at once.
integrationsRoutes.post('/integrations/criteriaiq/live-refresh', requireAppAdmin, async (req, res) => {
  const { randomBytes } = await import('node:crypto')
  const { setCriteriaIqWebhookSecret, getCriteriaIqConfigSummary } = await import('../../services/criteriaiq/config.js')
  const before = await getCriteriaIqConfigSummary()
  if (!before.configured) { res.status(409).json({ data: null, error: 'errors.criteriaiq.not_configured', meta: {} }); return }
  const secret = `ciqwh_${randomBytes(32).toString('base64url')}`
  await setCriteriaIqWebhookSecret(secret)
  await logAudit(req, { action: before.liveRefresh.enabled ? 'integration.criteriaiq.live_refresh.rotate' : 'integration.criteriaiq.live_refresh.enable', targetType: 'integration', targetId: 'criteriaiq' })
  res.json({ data: { secret, summary: await getCriteriaIqConfigSummary() }, error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/criteriaiq/live-refresh', requireAppAdmin, async (req, res) => {
  const { setCriteriaIqWebhookSecret, getCriteriaIqConfigSummary } = await import('../../services/criteriaiq/config.js')
  const before = await getCriteriaIqConfigSummary()
  if (before.liveRefresh.secretHint) {
    await setCriteriaIqWebhookSecret(null)
    await logAudit(req, { action: 'integration.criteriaiq.live_refresh.disable', targetType: 'integration', targetId: 'criteriaiq' })
  }
  res.json({ data: await getCriteriaIqConfigSummary(), error: null, meta: {} })
})

integrationsRoutes.post('/integrations/criteriaiq/test', requireAppAdmin, async (_req, res) => {
  const { testCriteriaIqConnection, CriteriaIqError } = await import('../../services/criteriaiq/client.js')
  try {
    await testCriteriaIqConnection()
    res.json({ data: { ok: true }, error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof CriteriaIqError ? err.code : 'errors.criteriaiq.unreachable', meta: {} })
  }
})

// Admin check of the Evaluation lookup: which CriteriaIQ projects point at
// a given CRM Evaluation record id.
integrationsRoutes.get('/integrations/criteriaiq/lookup', requireAppAdmin, async (req, res) => {
  const recordId = typeof req.query['recordId'] === 'string' ? req.query['recordId'].trim() : ''
  if (!/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(recordId)) {
    res.status(400).json({ data: null, error: 'errors.criteriaiq.invalid_record_id', meta: {} })
    return
  }
  const { findCriteriaIqProjectsByCrmRecord, CriteriaIqError } = await import('../../services/criteriaiq/client.js')
  try {
    res.json({ data: await findCriteriaIqProjectsByCrmRecord(recordId), error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof CriteriaIqError ? err.code : 'errors.criteriaiq.unreachable', meta: {} })
  }
})

// HubSpot connection (services/hubspot/, HubSpot plan phase 2a): one private
// app access token for the whole portal, stored encrypted; only its last 4
// characters are ever returned. Saving checks the token with HubSpot first.
// The token is also accepted while another CRM is active, so an admin can
// connect and check HubSpot before switching to it.
integrationsRoutes.get('/integrations/hubspot', requireAppAdmin, async (_req, res) => {
  const { getHubspotConnectionSummary } = await import('../../services/hubspot/connection.js')
  res.json({ data: await getHubspotConnectionSummary(), error: null, meta: {} })
})

integrationsRoutes.put('/integrations/hubspot', requireAppAdmin, async (req, res) => {
  const parsed = z.object({ accessToken: z.string().trim().min(20).max(512).regex(/^[\x21-\x7E]+$/) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.hubspot.token_invalid', meta: {} }); return }
  const { saveHubspotToken, getHubspotConnectionSummary } = await import('../../services/hubspot/connection.js')
  const result = await saveHubspotToken(parsed.data.accessToken)
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: {} }); return }
  await logAudit(req, { action: 'integration.hubspot.save', targetType: 'integration', targetId: 'hubspot', meta: { portalId: result.portal.portalId, portalName: result.portal.portalName, portalChanged: result.portalChanged } })
  res.json({ data: await getHubspotConnectionSummary(), error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/hubspot', requireAppAdmin, async (req, res) => {
  const { removeHubspotConnection } = await import('../../services/hubspot/connection.js')
  const result = await removeHubspotConnection()
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: {} }); return }
  await logAudit(req, { action: 'integration.hubspot.clear', targetType: 'integration', targetId: 'hubspot' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// Probes what the saved token can do (services/hubspot/capabilities.ts) and
// keeps the result for the card. Never creates or changes HubSpot records.
integrationsRoutes.post('/integrations/hubspot/test', requireAppAdmin, async (_req, res) => {
  const { runHubspotCapabilityCheck } = await import('../../services/hubspot/connection.js')
  const { HubspotError } = await import('../../services/hubspot/client.js')
  try {
    res.json({ data: await runHubspotCapabilityCheck(), error: null, meta: {} })
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.hubspot.unreachable'
    res.status(code === 'errors.hubspot.not_configured' ? 409 : 502).json({ data: null, error: code, meta: {} })
  }
})

// Gong connection (services/gong/, Gong plan phase 1): an access key pair
// (default) or an OAuth app, stored encrypted; only hints are ever returned.
// A new access key pair is tried against Gong before it is saved. The OAuth
// app is authorized from the browser through /auth/gong (routes/auth/gong.ts).
const gongSettingsSchema = z.object({
  authMethod: z.enum(['access_key', 'oauth']).optional(),
  apiBaseUrl: z.string().trim().min(1).max(200).optional(),
  accessKey: z.string().trim().min(8).max(256).regex(/^[\x21-\x7E]+$/).nullable().optional(),
  accessKeySecret: z.string().trim().min(8).max(512).regex(/^[\x21-\x7E]+$/).nullable().optional(),
  oauthClientId: z.string().trim().min(4).max(256).regex(/^[\x21-\x7E]+$/).nullable().optional(),
  oauthClientSecret: z.string().trim().min(8).max(512).regex(/^[\x21-\x7E]+$/).nullable().optional(),
  workspaceIds: z.array(z.string().trim().regex(/^\d{1,25}$/)).max(50).optional(),
  transcriptCacheDays: z.number().int().min(1).max(365).optional(),
})

integrationsRoutes.get('/integrations/gong', requireAppAdmin, async (_req, res) => {
  const { getGongConnectionSummary } = await import('../../services/gong/connection.js')
  res.json({ data: await getGongConnectionSummary(), error: null, meta: {} })
})

integrationsRoutes.put('/integrations/gong', requireAppAdmin, async (req, res) => {
  const parsed = gongSettingsSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.gong.settings_invalid', meta: {} }); return }
  const { saveGongSettings, getGongConnectionSummary } = await import('../../services/gong/connection.js')
  const d = parsed.data
  const result = await saveGongSettings(d)
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: {} }); return }
  await logAudit(req, {
    action: 'integration.gong.save',
    targetType: 'integration',
    targetId: 'gong',
    meta: {
      authMethod: d.authMethod ?? null,
      apiBaseUrl: d.apiBaseUrl ?? null,
      accessKeyChanged: !!d.accessKey,
      oauthClientChanged: !!d.oauthClientId || !!d.oauthClientSecret,
      workspaceIds: d.workspaceIds ?? null,
      transcriptCacheDays: d.transcriptCacheDays ?? null,
    },
  })
  res.json({ data: await getGongConnectionSummary(), error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/gong', requireAppAdmin, async (req, res) => {
  const { removeGongConnection } = await import('../../services/gong/connection.js')
  await removeGongConnection()
  await logAudit(req, { action: 'integration.gong.clear', targetType: 'integration', targetId: 'gong' })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// Probes each Gong scope the plan needs and keeps the result for the card.
// Reads only; never changes anything in Gong.
integrationsRoutes.post('/integrations/gong/test', requireAppAdmin, async (_req, res) => {
  const { runGongCapabilityCheck } = await import('../../services/gong/connection.js')
  const { GongError } = await import('../../services/gong/client.js')
  try {
    res.json({ data: await runGongCapabilityCheck(), error: null, meta: {} })
  } catch (err) {
    const code = err instanceof GongError ? err.code : 'errors.gong.unreachable'
    res.status(code === 'errors.gong.not_configured' ? 409 : 502).json({ data: null, error: code, meta: {} })
  }
})

integrationsRoutes.get('/integrations/gong/workspaces', requireAppAdmin, async (_req, res) => {
  const { listGongWorkspaces } = await import('../../services/gong/connection.js')
  const { GongError } = await import('../../services/gong/client.js')
  try {
    res.json({ data: await listGongWorkspaces(), error: null, meta: {} })
  } catch (err) {
    const code = err instanceof GongError ? err.code : 'errors.gong.unreachable'
    res.status(code === 'errors.gong.not_configured' ? 409 : 502).json({ data: null, error: code, meta: {} })
  }
})

integrationsRoutes.post('/integrations/gong/sync-users', requireAppAdmin, async (req, res) => {
  const { runGongUserSync } = await import('../../services/gong/users.js')
  const { getGongConnectionSummary } = await import('../../services/gong/connection.js')
  const { GongError } = await import('../../services/gong/client.js')
  try {
    const result = await runGongUserSync({ source: 'manual' })
    if (!result) { res.status(409).json({ data: null, error: 'errors.gong.not_configured', meta: {} }); return }
    await logAudit(req, { action: 'integration.gong.sync_users', targetType: 'integration', targetId: 'gong', meta: { ...result } })
    res.json({ data: await getGongConnectionSummary(), error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof GongError ? err.code : 'errors.gong.unreachable', meta: {} })
  }
})

// v1.456.0 (Gong plan, phase 3): auto-linking on/off and the public key
// that verifies Gong's signed webhooks (a PEM, or the bare base64 Gong
// shows). An empty key removes it, which turns the webhook off.
const gongLinkingSchema = z.object({
  autoLink: z.boolean().optional(),
  webhookPublicKey: z.string().max(8192).nullable().optional(),
})

integrationsRoutes.put('/integrations/gong/linking', requireAppAdmin, async (req, res) => {
  const parsed = gongLinkingSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.gong.settings_invalid', meta: {} }); return }
  const { updateGongSettings, getGongConfig } = await import('../../services/gong/config.js')
  const { normalizeGongPublicKey } = await import('../../services/gong/webhook.js')
  const { getGongConnectionSummary } = await import('../../services/gong/connection.js')
  // Auto-link and the webhook need a working Gong connection.
  if (!(await getGongConfig())) { res.status(409).json({ data: null, error: 'errors.gong.not_configured', meta: {} }); return }
  const d = parsed.data
  let webhookPublicKeyPem: string | null | undefined
  if (d.webhookPublicKey !== undefined) {
    const input = d.webhookPublicKey?.trim() ?? ''
    if (input === '') {
      webhookPublicKeyPem = null
    } else {
      webhookPublicKeyPem = normalizeGongPublicKey(input)
      if (!webhookPublicKeyPem) { res.status(400).json({ data: null, error: 'errors.gong.webhook_key_invalid', meta: {} }); return }
    }
  }
  await updateGongSettings({ autoLink: d.autoLink, webhookPublicKeyPem })
  await logAudit(req, {
    action: 'integration.gong.linking',
    targetType: 'integration',
    targetId: 'gong',
    meta: { autoLink: d.autoLink ?? null, webhookKey: webhookPublicKeyPem === undefined ? 'unchanged' : webhookPublicKeyPem ? 'set' : 'removed' },
  })
  res.json({ data: await getGongConnectionSummary(), error: null, meta: {} })
})

// v1.453.0 (Gong plan, phase 2): the Gong call index, run by hand.
integrationsRoutes.post('/integrations/gong/index-calls', requireAppAdmin, async (_req, res) => {
  const { runGongCallIndex } = await import('../../services/gong/calls.js')
  const { GongError } = await import('../../services/gong/client.js')
  try {
    const result = await runGongCallIndex({ source: 'manual' })
    if (!result) { res.status(409).json({ data: null, error: 'errors.gong.not_configured', meta: {} }); return }
    res.json({ data: result, error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof GongError ? err.code : 'errors.gong.unreachable', meta: {} })
  }
})

// Per-team "Leaders can read transcripts" (decided question 1).
integrationsRoutes.get('/integrations/gong/transcript-access', requireAppAdmin, async (_req, res) => {
  const { teams } = await import('../../../../drizzle/schema.js')
  const { asc } = await import('drizzle-orm')
  const rows = await db.select({ teamId: teams.id, name: teams.name, leadersCanRead: teams.transcriptsLeaderAccess })
    .from(teams).where(eq(teams.isActive, true)).orderBy(asc(teams.name))
  res.json({ data: rows, error: null, meta: {} })
})

const transcriptAccessSchema = z.object({ leadersCanRead: z.boolean() })

integrationsRoutes.put('/integrations/gong/transcript-access/:teamId', requireAppAdmin, async (req, res) => {
  const { teams } = await import('../../../../drizzle/schema.js')
  const teamId = typeof req.params['teamId'] === 'string' ? req.params['teamId'] : ''
  const parsed = transcriptAccessSchema.safeParse(req.body)
  if (!parsed.success || !z.string().uuid().safeParse(teamId).success) {
    res.status(400).json({ data: null, error: 'errors.validation', meta: {} })
    return
  }
  const [updated] = await db.update(teams).set({ transcriptsLeaderAccess: parsed.data.leadersCanRead }).where(eq(teams.id, teamId))
    .returning({ teamId: teams.id, name: teams.name, leadersCanRead: teams.transcriptsLeaderAccess })
  if (!updated) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await logAudit(req, { action: 'integration.gong.transcript_access', targetType: 'team', targetId: teamId, meta: { leadersCanRead: parsed.data.leadersCanRead } })
  res.json({ data: updated, error: null, meta: {} })
})

// Active Gong users, for the manual link picker.
integrationsRoutes.get('/integrations/gong/users', requireAppAdmin, async (_req, res) => {
  const { listGongUserOptions } = await import('../../services/gong/users.js')
  res.json({ data: await listGongUserOptions(), error: null, meta: {} })
})

const gongUserLinkSchema = z.object({ gongUserId: z.string().regex(/^\d{1,30}$/).nullable() })

// Link an ImpactIQ user to a Gong user by hand (overrides the email match),
// or clear the link with null.
integrationsRoutes.put('/integrations/gong/user-links/:userId', requireAppAdmin, async (req, res) => {
  const { setUserGongLink } = await import('../../services/gong/identity.js')
  const { getGongConnectionSummary } = await import('../../services/gong/connection.js')
  const userId = typeof req.params['userId'] === 'string' ? req.params['userId'] : ''
  const parsed = gongUserLinkSchema.safeParse(req.body)
  if (!parsed.success || !z.string().uuid().safeParse(userId).success) {
    res.status(400).json({ data: null, error: 'errors.validation', meta: {} })
    return
  }
  if (!(await setUserGongLink(userId, parsed.data.gongUserId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
    return
  }
  await logAudit(req, { action: 'integration.gong.user_link', targetType: 'user', targetId: userId, meta: { gongUserId: parsed.data.gongUserId } })
  res.json({ data: await getGongConnectionSummary(), error: null, meta: {} })
})

// A HubSpot object's properties for the field mapping pickers (phase 2b part
// 2), shaped like GET /sf/fields. Always read fresh, so a property created a
// minute ago in HubSpot shows up. Deal properties are also open to any
// admin (the router's baseline), since a team admin picks one for an
// Activity Type's Opp field extra; the other objects stay App Admin only.
integrationsRoutes.get('/hubspot/properties', (req, res, next) => {
  if (req.query['object'] === 'deals') { next(); return }
  void requireAppAdmin(req, res, next)
}, async (req, res) => {
  const { isHubspotMappingTarget } = await import('../../../shared/hubspot.js')
  const object = req.query['object']
  if (typeof object !== 'string' || !isHubspotMappingTarget(object)) {
    res.status(400).json({ data: null, error: 'errors.hubspot.invalid_object', meta: {} })
    return
  }
  const { getObjectProperties, toPropertyField } = await import('../../services/hubspot/metadata.js')
  const { HubspotError } = await import('../../services/hubspot/client.js')
  try {
    const props = await getObjectProperties(object, { fresh: true })
    const fields = [...props.values()].map(toPropertyField).sort((a, b) => a.label.localeCompare(b.label))
    res.json({ data: { object, fields }, error: null, meta: {} })
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.hubspot.unreachable'
    res.status(code === 'errors.hubspot.not_configured' ? 412 : 502).json({ data: null, error: code, meta: {} })
  }
})

// The Project objects this HubSpot portal offers (phase 6b): HubSpot's own
// Projects object when the key can read it, plus any custom object. For the
// Project picker on Admin → Activity Types and the mappings screen, so any
// admin who manages either may list them.
integrationsRoutes.get('/hubspot/project-objects', async (_req, res) => {
  const { listHubspotProjectObjects } = await import('../../services/hubspot/projects.js')
  const { HubspotError } = await import('../../services/hubspot/client.js')
  try {
    res.json({ data: await listHubspotProjectObjects(), error: null, meta: {} })
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.hubspot.unreachable'
    res.status(code === 'errors.hubspot.not_configured' ? 412 : 502).json({ data: null, error: code, meta: {} })
  }
})

// Who can edit Deals (v1.424.0, security audit M4): anyone matched to a
// HubSpot user, or only people named in the chosen Deal properties.
integrationsRoutes.get('/integrations/hubspot/deal-edit', requireAppAdmin, async (_req, res) => {
  const { getHubspotDealEditPolicy } = await import('../../services/hubspot/dealEditPolicy.js')
  res.json({ data: await getHubspotDealEditPolicy(), error: null, meta: {} })
})

integrationsRoutes.put('/integrations/hubspot/deal-edit', requireAppAdmin, async (req, res) => {
  const { MAX_DEAL_EDIT_PROPERTIES } = await import('../../../shared/hubspotDealEdit.js')
  const parsed = z.object({
    mode: z.enum(['any_matched_user', 'named_on_deal']),
    properties: z.array(z.string().regex(/^[A-Za-z0-9_]{1,100}$/)).max(MAX_DEAL_EDIT_PROPERTIES),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} }); return }
  if (parsed.data.mode === 'named_on_deal' && parsed.data.properties.length === 0) {
    res.status(400).json({ data: null, error: 'errors.hubspot.deal_edit_needs_property', meta: {} })
    return
  }
  const { setHubspotDealEditPolicy } = await import('../../services/hubspot/dealEditPolicy.js')
  const saved = await setHubspotDealEditPolicy(parsed.data)
  await logAudit(req, { action: 'integration.hubspot.deal_edit_policy', targetType: 'integration', targetId: 'hubspot', meta: { ...saved } })
  res.json({ data: saved, error: null, meta: {} })
})

integrationsRoutes.post('/integrations/hubspot/sync-owners', requireAppAdmin, async (req, res) => {
  const { runHubspotOwnerSync } = await import('../../services/hubspot/owners.js')
  const { getHubspotConnectionSummary } = await import('../../services/hubspot/connection.js')
  const { HubspotError } = await import('../../services/hubspot/client.js')
  const { isCrmProviderActive } = await import('../../services/crm/providerSetting.js')
  // v1.437.1: owners are only synced while HubSpot is the active CRM.
  if (!(await isCrmProviderActive('hubspot'))) {
    res.status(409).json({ data: null, error: 'errors.hubspot.owner_sync_inactive_crm', meta: {} }); return
  }
  try {
    const result = await runHubspotOwnerSync({ source: 'manual' })
    if (!result) { res.status(409).json({ data: null, error: 'errors.hubspot.not_configured', meta: {} }); return }
    await logAudit(req, { action: 'integration.hubspot.sync_owners', targetType: 'integration', targetId: 'hubspot', meta: { ...result } })
    res.json({ data: await getHubspotConnectionSummary(), error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof HubspotError ? err.code : 'errors.hubspot.unreachable', meta: {} })
  }
})

// App-wide login screen logo (the large graphic above the sign-in card) —
// see services/config/integrations.ts's getLoginLogo/setLoginLogo. Reuses
// validateLogoDataUrl's MIME allowlist + size cap so this can never store a
// non-image data URI. A non-empty value that fails validation is rejected
// with 400 rather than silently cleared.
integrationsRoutes.get('/integrations/login-logo', requireAppAdmin, async (_req, res) => {
  const { getLoginLogoConfig } = await import('../../services/config/integrations.js')
  res.json({ data: await getLoginLogoConfig(), error: null, meta: {} })
})

// Every field is optional so the image and its display size save
// independently: { dataUrl } replaces/clears the image, { width, height }
// (px, or null for "default by the image's shape") resizes it.
integrationsRoutes.put('/integrations/login-logo', requireAppAdmin, async (req, res) => {
  const dim = z.number().int().min(LOGIN_LOGO_SIZE_MIN).max(LOGIN_LOGO_SIZE_MAX).nullable().optional()
  const schema = z.object({ dataUrl: z.string().nullable().optional(), width: dim, height: dim })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { setLoginLogoConfig, getLoginLogoConfig } = await import('../../services/config/integrations.js')
  const patch: { dataUrl?: string | null; width?: number | null; height?: number | null } = {}
  if (parsed.data.dataUrl !== undefined) {
    const raw = parsed.data.dataUrl
    const clean = validateLogoDataUrl(raw)
    if (raw && !clean) { res.status(400).json({ data: null, error: 'errors.themes.invalid_login_logo', meta: {} }); return }
    patch.dataUrl = clean
  }
  if (parsed.data.width !== undefined) patch.width = parsed.data.width
  if (parsed.data.height !== undefined) patch.height = parsed.data.height
  await setLoginLogoConfig(patch)
  const after = await getLoginLogoConfig()
  if ('dataUrl' in patch) {
    await logAudit(req, { action: patch.dataUrl ? 'integration.login_logo.save' : 'integration.login_logo.clear', targetType: 'integration', targetId: 'login_logo' })
  }
  if ('width' in patch || 'height' in patch) {
    await logAudit(req, { action: 'integration.login_logo.resize', targetType: 'integration', targetId: 'login_logo', meta: { width: after.width, height: after.height } })
  }
  res.json({ data: after, error: null, meta: {} })
})

// v1.113.0: Email Communications registry. GET returns every rule row;
// PATCH updates is_active (plus subject_template / body_template when
// we ship the template editor). Cache is invalidated so senders pick
// up the change on the very next call.
integrationsRoutes.get('/email-rules', requireAppAdmin, async (_req, res) => {
  const { emailRules } = await import('../../../../drizzle/schema.js')
  const rows = await db.select().from(emailRules).orderBy(emailRules.name)
  // v1.436.0: the page shows the "Also send as Slack DM" switch as usable
  // only once the Slack bot is connected.
  const { getSlackConfigSummary } = await import('../../services/slack/client.js')
  const { configured: slackConfigured } = await getSlackConfigSummary()
  res.json({ data: rows, error: null, meta: { slackConfigured } })
})

integrationsRoutes.patch('/email-rules/:key', requireAppAdmin, async (req, res) => {
  const { key } = req.params as { key: string }
  const schema = z.object({
    isActive: z.boolean().optional(),
    subjectTemplate: z.string().nullable().optional(),
    bodyTemplate: z.string().nullable().optional(),
    sendSlack: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  if (parsed.data.sendSlack === true && !emailRuleSupportsSlackDm(key)) {
    res.status(400).json({ data: null, error: 'errors.email_rule.slack_not_supported', meta: {} }); return
  }
  const { emailRules } = await import('../../../../drizzle/schema.js')
  const patch: Record<string, unknown> = { ...definedEntries(parsed.data), updatedAt: new Date() }
  const [updated] = await db.update(emailRules).set(patch).where(eq(emailRules.key, key)).returning()
  if (!updated) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  try {
    const { invalidateEmailRuleCache } = await import('../../services/email/rules.js')
    invalidateEmailRuleCache()
  } catch { /* ignore */ }
  res.json({ data: updated, error: null, meta: {} })
})

// v1.115.0: render a rule preview HTML without sending — pipes through
// the same renderEmailTemplate() wrap that production emails use, so
// admins see EXACTLY what recipients will see including theme + logo
// + interpolated sample tokens. Returns { html } for iframe srcDoc.
integrationsRoutes.post('/email-rules/:key/preview', requireAppAdmin, async (req, res) => {
  const { key } = req.params as { key: string }
  const bodySchema = z.object({ subjectTemplate: z.string().nullable().optional(), bodyTemplate: z.string().nullable().optional() })
  const parsed = bodySchema.safeParse(req.body ?? {})
  const overrideSubject = parsed.success ? parsed.data.subjectTemplate ?? null : null
  const overrideBody = parsed.success ? parsed.data.bodyTemplate ?? null : null
  const sampleTokens: Record<string, string> = {
    name: req.user?.displayName ?? 'Admin',
    ip: '203.0.113.42',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestAgent',
    signInTime: new Date().toISOString(),
    weekLabel: 'Jul 14–Jul 20, 2026',
    totalHours: '32.5',
    capacityHours: '40.0',
    count: '3',
    itemsList: '<ul><li>Sample nudge one</li><li>Sample nudge two</li><li>Sample nudge three</li></ul>',
    message: 'Sample nudge message for preview.',
    triggeredBy: req.user?.email ?? 'admin@example.com',
    // Welcome / invitation preview tokens.
    tempPassword: 'ChangeMeSoon-123',
    teamName: 'Sample Team',
    loginUrl: (process.env['APP_URL'] ?? '') + '/login',
    // job_failure_alert preview tokens (see writeRun.ts).
    jobKey: 'refresh_opp_snapshots',
    when: new Date().toISOString(),
  }
  const defaults: Record<string, { subject: string; html: string; text: string }> = {
    job_failure_alert: {
      subject: '[ImpactIQ] Job failed: {{jobKey}}',
      html: '<p><strong>Job:</strong> {{jobKey}}</p><p><strong>When:</strong> {{when}}</p><p><strong>Message:</strong></p><pre>{{message}}</pre>',
      text: 'Job {{jobKey}} failed at {{when}}: {{message}}',
    },
    login_new_location: {
      subject: 'New sign-in to your ImpactIQ account',
      html: '<p>Hi {{name}},</p><p>We noticed a sign-in from a new location.</p><ul><li>IP: {{ip}}</li><li>User agent: {{userAgent}}</li></ul>',
      text: 'Hi {{name}},\nIP: {{ip}}\nUser agent: {{userAgent}}\n',
    },
    weekly_recap: {
      subject: 'ImpactIQ weekly recap: {{weekLabel}}',
      html: '<p>Hi {{name}},</p><p>Total hours: {{totalHours}} / {{capacityHours}}.</p>',
      text: 'Hi {{name}},\nTotal hours: {{totalHours}} / {{capacityHours}}.\n',
    },
    daily_digest: {
      subject: 'ImpactIQ — {{count}} new notification(s)',
      html: '<p>Hi {{name}},</p><p>You have {{count}} new notifications.</p>{{itemsList}}',
      text: 'Hi {{name}},\nYou have {{count}} new notifications.\n',
    },
    nudge_email: {
      subject: 'ImpactIQ nudge: {{message}}',
      html: '<p>{{message}}</p>',
      text: '{{message}}',
    },
    admin_test_email: {
      subject: 'ImpactIQ: test email',
      html: '<p>Hi {{name}},</p><p>This is a test email triggered by {{triggeredBy}}.</p>',
      text: 'Hi {{name}},\nThis is a test email triggered by {{triggeredBy}}.\n',
    },
    smtp_test: {
      subject: 'ImpactIQ: email configuration test',
      html: '<p>Hi {{name}},</p><p>SMTP round-trip works. Triggered by {{triggeredBy}}.</p>',
      text: 'Hi {{name}},\nSMTP round-trip works. Triggered by {{triggeredBy}}.\n',
    },
    welcome: {
      subject: 'Welcome to ImpactIQ',
      html: '<p>Hi {{name}},</p><p>Welcome to ImpactIQ. You\'ve been added to the <b>{{teamName}}</b> team.</p><p><a href="{{loginUrl}}">Sign in to get started</a>.</p>',
      text: 'Hi {{name}},\nWelcome to ImpactIQ. You\'ve been added to the {{teamName}} team.\nSign in: {{loginUrl}}\n',
    },
    invitation: {
      subject: 'Your ImpactIQ account is ready',
      html: '<p>Hi {{name}},</p><p>An admin created an ImpactIQ account for you on the <b>{{teamName}}</b> team.</p><p><b>Sign in URL:</b> <a href="{{loginUrl}}">{{loginUrl}}</a><br><b>Temporary password:</b> <code>{{tempPassword}}</code></p><p>You\'ll be asked to change the password on your first sign-in.</p>',
      text: 'Hi {{name}},\nAn admin created an ImpactIQ account for you on the {{teamName}} team.\nSign in URL: {{loginUrl}}\nTemporary password: {{tempPassword}}\nYou\'ll be asked to change the password on your first sign-in.\n',
    },
  }
  const d = defaults[key]
  if (!d) { res.status(404).json({ data: null, error: 'errors.email_rule.unknown_key', meta: {} }); return }
  const { db } = await import('../../db/index.js')
  const { emailRules } = await import('../../../../drizzle/schema.js')
  const [row] = await db.select().from(emailRules).where(eq(emailRules.key, key)).limit(1)
  const subjectTpl = overrideSubject ?? row?.subjectTemplate ?? d.subject
  const bodyTpl = overrideBody ?? row?.bodyTemplate ?? d.html
  const interpolate = (s: string) => s.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, k: string) => sampleTokens[k] ?? `{{${k}}}`)
  const subject = interpolate(subjectTpl)
  const bodyHtml = interpolate(bodyTpl)
  const { renderEmailTemplate, loadActiveThemeEmailConfig } = await import('../../services/email/template.js')
  const cfg = await loadActiveThemeEmailConfig()
  const rendered = renderEmailTemplate({ greetingName: req.user?.displayName ?? 'Admin', subject, bodyHtml, bodyText: htmlToText(bodyHtml) }, cfg, { mode: 'preview' })
  res.json({ data: { html: rendered.html, subject }, error: null, meta: {} })
})

// v1.114.0: preview a rule by sending a live test to the admin's own
// email address. Uses the same sendByRule path production emails go
// through, so admins see EXACTLY what recipients will see including
// the theme, tokens, and template overrides. Substitutes fake but
// representative sample tokens so custom {{name}} etc. render.
integrationsRoutes.post('/email-rules/:key/send-test', requireAppAdmin, async (req, res) => {
  const { key } = req.params as { key: string }
  const to = req.user?.email
  if (!to) { res.status(400).json({ data: null, error: 'errors.no_admin_email', meta: {} }); return }
  const displayName = req.user?.displayName ?? 'Admin'
  const sampleTokens: Record<string, string> = {
    name: displayName,
    ip: '203.0.113.42',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestAgent',
    signInTime: new Date().toISOString(),
    weekLabel: 'Jul 14–Jul 20, 2026',
    totalHours: '32.5',
    capacityHours: '40.0',
    count: '3',
    itemsList: '• Sample nudge one\n• Sample nudge two\n• Sample nudge three',
    message: 'Sample nudge message for preview.',
    triggeredBy: to,
    // job_failure_alert preview tokens (see writeRun.ts).
    jobKey: 'refresh_opp_snapshots',
    when: new Date().toISOString(),
  }
  const defaults: Record<string, { subject: string; html: string; text: string }> = {
    job_failure_alert: {
      subject: '[ImpactIQ] Job failed: {{jobKey}}',
      html: '<p><strong>Job:</strong> {{jobKey}}</p><p><strong>When:</strong> {{when}}</p><p><strong>Message:</strong></p><pre>{{message}}</pre>',
      text: 'Job {{jobKey}} failed at {{when}}: {{message}}',
    },
    login_new_location: {
      subject: 'New sign-in to your ImpactIQ account',
      html: '<p>Hi {{name}},</p><p>We noticed a sign-in from a new location.</p><ul><li>IP: {{ip}}</li><li>User agent: {{userAgent}}</li></ul>',
      text: 'Hi {{name}},\n\nWe noticed a sign-in from a new location.\nIP: {{ip}}\nUser agent: {{userAgent}}\n',
    },
    weekly_recap: {
      subject: 'ImpactIQ weekly recap: {{weekLabel}}',
      html: '<p>Hi {{name}},</p><p>Total hours: {{totalHours}} / {{capacityHours}}.</p>',
      text: 'Hi {{name}},\n\nTotal hours: {{totalHours}} / {{capacityHours}}.\n',
    },
    daily_digest: {
      subject: 'ImpactIQ — {{count}} new notification(s)',
      html: '<p>Hi {{name}},</p><p>You have {{count}} new notifications.</p><pre>{{itemsList}}</pre>',
      text: 'Hi {{name}},\n\nYou have {{count}} new notifications.\n{{itemsList}}\n',
    },
    nudge_email: {
      subject: 'ImpactIQ nudge: {{message}}',
      html: '<p>{{message}}</p>',
      text: '{{message}}',
    },
    admin_test_email: {
      subject: 'ImpactIQ: test email',
      html: '<p>Hi {{name}},</p><p>This is a test email triggered by {{triggeredBy}}. If you received this, your email configuration is working.</p>',
      text: 'Hi {{name}},\n\nThis is a test email triggered by {{triggeredBy}}. If you received this, your email configuration is working.\n',
    },
    smtp_test: {
      subject: 'ImpactIQ: email configuration test',
      html: '<p>Hi {{name}},</p><p>SMTP round-trip works. Triggered by {{triggeredBy}}.</p>',
      text: 'Hi {{name}},\n\nSMTP round-trip works. Triggered by {{triggeredBy}}.\n',
    },
  }
  const d = defaults[key]
  if (!d) { res.status(404).json({ data: null, error: 'errors.email_rule.unknown_key', meta: {} }); return }
  try {
    const { sendByRule } = await import('../../services/email/rule-sender.js')
    // Bypass the isActive gate here — admins are explicitly testing.
    // Load templates + interpolate manually so an inactive rule still
    // renders.
    const { db } = await import('../../db/index.js')
    const { emailRules } = await import('../../../../drizzle/schema.js')
    const [row] = await db.select().from(emailRules).where(eq(emailRules.key, key)).limit(1)
    const subjectTpl = row?.subjectTemplate ?? d.subject
    const bodyTpl = row?.bodyTemplate ?? d.html
    void sendByRule // referenced so future refactor keeps import
    const interpolate = (s: string) => s.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, k: string) => sampleTokens[k] ?? '')
    const subject = interpolate(subjectTpl)
    const html = interpolate(bodyTpl)
    const text = interpolate(row?.bodyTemplate ? htmlToText(bodyTpl) : d.text)
    // v1.436.0: a rule with "Also send as Slack DM" on also DMs the admin,
    // so the test shows both copies.
    let slackNote = ''
    let dmSent = false
    if (row?.sendSlack && emailRuleSupportsSlackDm(key) && req.user?.id) {
      const { deliverSlackDmToUser } = await import('../../services/slack/dm.js')
      const dm = await deliverSlackDmToUser(req.user.id, { heading: subject, text, severity: 'info' })
      dmSent = dm.ok
      slackNote = dm.ok ? ' and Slack DM sent' : ` (Slack DM skipped: ${dm.reason})`
    }
    if (!getEmailIntegrationConfig() && dmSent) {
      res.json({ data: { ok: true, message: 'Test Slack DM sent (email isn\u2019t configured)' }, error: null, meta: {} })
      return
    }
    const { sendEmailViaConfigured } = await import('../../services/email/index.js')
    await sendEmailViaConfigured({ to, toName: displayName, subject, html, text, category: 'test' })
    res.json({ data: { ok: true, message: `Test email sent to ${to}${slackNote}` }, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(502).json({ data: null, error: `send failed: ${message}`, meta: {} })
  }
})

integrationsRoutes.get('/integrations/sf-internal-domains', requireAppAdmin, async (_req, res) => {
  const domains = await getSfInternalDomains()
  res.json({ data: { domains }, error: null, meta: {} })
})

integrationsRoutes.put('/integrations/sf-internal-domains', requireAppAdmin, async (req, res) => {
  const schema = z.object({ domains: z.array(z.string().max(120)).max(50) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await setSfInternalDomains(parsed.data.domains)
  res.json({ data: { domains: parsed.data.domains }, error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/config/okta', requireAppAdmin, async (_req, res) => {
  await clearOktaIntegrationConfig()
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// "smtp" path retained for URL stability; payload now describes either SMTP or Graph App-Only.
integrationsRoutes.put('/integrations/config/smtp', requireAppAdmin, async (req, res) => {
  const parsed = EmailConfigSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const existing = getEmailIntegrationConfig()
  if (parsed.data.authMethod === 'smtp') {
    const password = parsed.data.password || (existing?.authMethod === 'smtp' ? existing.password : undefined)
    if (!password) { res.status(400).json({ data: null, error: 'errors.validation.password_required', meta: {} }); return }
    await saveSmtpIntegrationConfig({ ...parsed.data, password })
  } else {
    const clientSecret = parsed.data.clientSecret || (existing?.authMethod === 'graph_app' ? existing.clientSecret : undefined)
    if (!clientSecret) { res.status(400).json({ data: null, error: 'errors.validation.client_secret_required', meta: {} }); return }
    await saveSmtpIntegrationConfig({ ...parsed.data, clientSecret })
  }
  res.json({ data: getIntegrationConfigSummary().smtp, error: null, meta: {} })
})

integrationsRoutes.delete('/integrations/config/smtp', requireAppAdmin, async (_req, res) => {
  await clearSmtpIntegrationConfig()
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// ─── Test connection endpoints ──────────────────────────────────────────────
// Each returns { ok: boolean, message: string, details?: unknown }. They use
// the CURRENTLY-SAVED config (so the admin saves first, then tests).

function normalizeOktaHost(domain: string): string {
  return /^https?:\/\//.test(domain) ? domain.replace(/\/$/, '') : `https://${domain}`
}

integrationsRoutes.post('/integrations/test/okta', requireAppAdmin, async (_req, res) => {
  const cfg = getOktaIntegrationConfig()
  if (!cfg) { res.json({ data: { ok: false, message: 'Okta is not configured. Save credentials first.' }, error: null, meta: {} }); return }
  try {
    const url = `${normalizeOktaHost(cfg.domain)}/.well-known/openid-configuration`
    // Security fix (same class as F-01/F-02, pentest 2026-09): defense in
    // depth against a legacy stored value — see the PUT handler above.
    const r = await safeFetch(url)
    if (!r.ok) {
      res.json({ data: { ok: false, message: `Okta OIDC discovery returned ${r.status} at ${url}` }, error: null, meta: {} })
      return
    }
    const j = (await r.json()) as { issuer?: string; authorization_endpoint?: string }
    res.json({ data: { ok: true, message: `Connected to Okta (${j.issuer ?? cfg.domain})`, details: { issuer: j.issuer, clientId: cfg.clientId } }, error: null, meta: {} })
  } catch (err) {
    res.json({ data: { ok: false, message: err instanceof Error ? err.message : 'Network error contacting Okta' }, error: null, meta: {} })
  }
})

// POST /api/admin/integrations/test/admin-salesforce — exercises the
// stored org-wide admin OAuth token by running a lightweight SOQL
// query. Fails loudly if the token is expired or revoked so admins can
// diagnose why config dropdowns (fields, users, departments) return
// empty on the admin side.
integrationsRoutes.post('/integrations/test/admin-salesforce', requireAppAdmin, async (_req, res) => {
  const conn = await getAdminSfConnection()
  if (!conn) {
    res.json({ data: { ok: false, message: 'Admin Salesforce Connection is not configured. Click Connect on the card above.' }, error: null, meta: {} })
    return
  }
  try {
    const q = await conn.query('SELECT Id FROM Organization LIMIT 1')
    const orgId = (q.records[0] as { Id?: string } | undefined)?.Id ?? null
    // v1.108.0: push the fresh healthy=true into the shared cache so
    // the /salesforce-admin/status endpoint returns it on the next
    // read (loadAll() from the client). Without this the banner stayed
    // red for up to 60s until the cached "unhealthy" TTL expired.
    const { setAdminSfHealth } = await import('../auth.js')
    setAdminSfHealth(true)
    res.json({ data: { ok: true, message: `Reached Salesforce${orgId ? ` (Org ${orgId})` : ''}` }, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const { setAdminSfHealth } = await import('../auth.js')
    setAdminSfHealth(false, message)
    res.json({ data: { ok: false, message: `SOQL failed: ${message}` }, error: null, meta: {} })
  }
})

integrationsRoutes.post('/integrations/test/salesforce', requireAppAdmin, async (_req, res) => {
  const cfg = getSfIntegrationConfig()
  if (!cfg) { res.json({ data: { ok: false, message: 'Salesforce is not configured. Save credentials first.' }, error: null, meta: {} }); return }
  try {
    // Security fix (F-01, pentest 2026-09): this made an unguarded server-
    // side fetch and reflected the raw HTTP status back to the caller — a
    // blind SSRF probe primitive. loginUrl is now also validated at save
    // time, but this stays as defense in depth against a legacy stored
    // value or an SF_LOGIN_URL env override.
    await assertSalesforceLoginUrl(cfg.loginUrl)
    const url = `${cfg.loginUrl.replace(/\/$/, '')}/services/oauth2/userinfo`
    // We don't have a token; just check the endpoint exists (will return 401 without a token, which IS a successful reachability test).
    const r = await safeFetch(url)
    if (r.status === 401 || r.status === 403 || r.ok) {
      res.json({ data: { ok: true, message: `Reached Salesforce login URL (${cfg.loginUrl})`, details: { status: r.status } }, error: null, meta: {} })
      return
    }
    res.json({ data: { ok: false, message: `Salesforce returned ${r.status} at ${url}` }, error: null, meta: {} })
  } catch (err) {
    res.json({ data: { ok: false, message: err instanceof Error ? err.message : 'Network error contacting Salesforce' }, error: null, meta: {} })
  }
})

integrationsRoutes.post('/integrations/test/microsoft', requireAppAdmin, async (_req, res) => {
  const cfg = getMsIntegrationConfig()
  if (!cfg) { res.json({ data: { ok: false, message: 'Microsoft is not configured. Save credentials first.' }, error: null, meta: {} }); return }
  try {
    // Check the tenant's OpenID configuration endpoint.
    const url = microsoftLoginUrl(cfg.tenantId, '/v2.0/.well-known/openid-configuration')
    const r = await fetch(url)
    if (!r.ok) {
      res.json({ data: { ok: false, message: `Microsoft tenant discovery returned ${r.status}. Check the Tenant ID.` }, error: null, meta: {} })
      return
    }
    const j = (await r.json()) as { issuer?: string }
    res.json({ data: { ok: true, message: `Connected to Microsoft tenant (${j.issuer ?? cfg.tenantId})`, details: { issuer: j.issuer, clientId: cfg.clientId } }, error: null, meta: {} })
  } catch (err) {
    res.json({ data: { ok: false, message: err instanceof Error ? err.message : 'Network error contacting Microsoft' }, error: null, meta: {} })
  }
})

// v1.77.0: send a real test email to an arbitrary recipient. Uses the
// currently-saved email config (SMTP or Graph). Falls back to the caller's
// own email when the request doesn't include one, so the existing
// "Test connection" button keeps working.
integrationsRoutes.post('/integrations/email/send-test', requireAppAdmin, async (req, res) => {
  const parsed = z.object({ to: z.string().email() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const cfg = getEmailIntegrationConfig()
  if (!cfg) { res.status(400).json({ data: null, error: 'Email is not configured. Save credentials first.', meta: {} }); return }
  try {
    const { sendEmailViaConfigured } = await import('../../services/email/index.js')
    await sendEmailViaConfigured({
      to: parsed.data.to,
      category: 'test',
      subject: 'ImpactIQ: test email',
      text: `This is a test email from ImpactIQ triggered by ${req.user?.email ?? 'an admin'}. If you received this, your email configuration is working.`,
      html: `<p>This is a test email from ImpactIQ triggered by <strong>${req.user?.email ?? 'an admin'}</strong>. If you received this, your email configuration is working.</p>`,
    })
    res.json({ data: { ok: true, message: `Test email sent to ${parsed.data.to}.` }, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(502).json({ data: null, error: `Test email failed: ${message}`, meta: {} })
  }
})

integrationsRoutes.post('/integrations/test/smtp', requireAppAdmin, async (req, res) => {
  const cfg = getEmailIntegrationConfig()
  if (!cfg) { res.json({ data: { ok: false, message: 'Email is not configured. Save credentials first.' }, error: null, meta: {} }); return }
  const toAddress = req.user?.email
  if (!toAddress) { res.json({ data: { ok: false, message: 'No email address on file for the current admin user.' }, error: null, meta: {} }); return }
  try {
    if (cfg.authMethod === 'graph_app') {
      // Test by minting an app token via client_credentials. Verifies tenant +
      // client id + secret + that Mail.Send was consented (token will include
      // the scope claim). We deliberately don't actually send mail in the test.
      const tokenRes = await fetch(microsoftLoginUrl(cfg.tenantId, '/oauth2/v2.0/token'), {
        method: 'POST',
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
      })
      if (!tokenRes.ok) {
        res.json({ data: { ok: false, message: `Token endpoint returned ${tokenRes.status}: ${await tokenRes.text()}` }, error: null, meta: {} })
        return
      }
      const tokenJson = (await tokenRes.json()) as { access_token: string; scope?: string }
      // We deliberately do NOT probe /users/{mailbox} here: that endpoint
      // requires User.Read.All, which is a broader Graph permission than
      // Mail.Send needs. Apps scoped to Mail.Send only (or locked to a
      // single mailbox via an Application Access Policy) would return 403
      // on the probe even though sendMail works — that's exactly what we
      // hit here (CriteriaIQ uses the same creds and sends fine).
      // Token acquisition already proves tenant + client id + secret;
      // consented scopes are visible in the token response. Send Test
      // Email below is the definitive end-to-end check.
      const scopeNote = tokenJson.scope ? ` (scopes: ${tokenJson.scope})` : ''
      res.json({
        data: {
          ok: true,
          message: `Token acquired successfully${scopeNote}. Use Send Test Email below to verify the sender mailbox and Application Access Policy.`,
        },
        error: null,
        meta: {},
      })
    } else {
      // SMTP: try opening the connection + EHLO + AUTH LOGIN to verify creds without sending.
      const { sendEmailViaConfigured } = await import('../../services/email/index.js')
      // Easiest: actually send a tiny test email to the admin. That's the only fully-conclusive SMTP test.
      const msg: { to: string; toName?: string; subject: string; text: string; html: string; category: string } = {
        to: toAddress,
        category: 'test',
        subject: 'ImpactIQ: email configuration test',
        text: 'This is a test message confirming your SMTP relay is working.',
        html: '<p>This is a test message confirming your SMTP relay is working.</p>',
      }
      if (req.user?.displayName) msg.toName = req.user.displayName
      await sendEmailViaConfigured(msg)
      res.json({ data: { ok: true, message: `Test email sent to ${toAddress}. Check your inbox.` }, error: null, meta: {} })
    }
  } catch (err) {
    res.json({ data: { ok: false, message: err instanceof Error ? err.message : 'Network error' }, error: null, meta: {} })
  }
})
