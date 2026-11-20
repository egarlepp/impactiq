import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { inArray, eq } from 'drizzle-orm'
import { encryptToken, decryptToken } from './crypto.js'
import { normalizeLoginLogoDimension } from '../../../shared/loginLogoSize.js'

const KEY_SF = 'integration_config_salesforce'
const KEY_MS = 'integration_config_microsoft'
const KEY_OKTA = 'integration_config_okta'
const KEY_AZURE_SSO = 'integration_config_azure_sso'
const KEY_EMAIL = 'integration_config_smtp' // legacy key name; stores either SMTP or Graph App-Only shape
const KEY_OUTLOOK_APP_ONLY = 'outlook_app_only_enabled'

export async function isOutlookAppOnlyEnabled(): Promise<boolean> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_OUTLOOK_APP_ONLY)).limit(1)
    const val = row?.value as { enabled?: boolean } | undefined
    return Boolean(val?.enabled)
  } catch {
    return false
  }
}

export async function setOutlookAppOnlyEnabled(enabled: boolean): Promise<void> {
  await upsert(KEY_OUTLOOK_APP_ONLY, { enabled })
}

// Outlook sync retention + forward-window config
const KEY_OUTLOOK_SYNC = 'outlook_sync_settings'
// v1.162.0: internalEmailDomains decides which write-back attendees become
// real Required attendees (they get an Outlook invite). Empty = fall back to
// the organizer's own login-email domain (previous behavior).
export interface OutlookSyncSettings { forwardDays: number; retentionDays: number; internalEmailDomains: string[] }
const DEFAULT_OUTLOOK_SYNC: OutlookSyncSettings = { forwardDays: 30, retentionDays: 730, internalEmailDomains: [] }

// Normalize a domain list: lowercase, strip a leading "@", drop blanks/dupes.
export function normalizeDomains(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(/[\s,;]+/) : []
  const seen = new Set<string>()
  for (const d of raw) {
    const clean = String(d).trim().toLowerCase().replace(/^@+/, '')
    if (clean && clean.includes('.')) seen.add(clean)
  }
  return Array.from(seen)
}

export async function getOutlookSyncSettings(): Promise<OutlookSyncSettings> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_OUTLOOK_SYNC)).limit(1)
    const val = row?.value as Partial<OutlookSyncSettings> | undefined
    return {
      forwardDays: Math.max(0, Math.min(90, Number(val?.forwardDays ?? DEFAULT_OUTLOOK_SYNC.forwardDays))),
      retentionDays: Math.max(30, Math.min(3650, Number(val?.retentionDays ?? DEFAULT_OUTLOOK_SYNC.retentionDays))),
      internalEmailDomains: normalizeDomains(val?.internalEmailDomains),
    }
  } catch {
    return DEFAULT_OUTLOOK_SYNC
  }
}
export async function setOutlookSyncSettings(v: OutlookSyncSettings): Promise<void> {
  await upsert(KEY_OUTLOOK_SYNC, v)
}

// Okta email_verified gate. Default is STRICT: refuse JIT provisioning or
// account-link when the id_token claim is missing or false. Admins whose
// IdP doesn't set the claim can opt out here, but the tradeoff (impostor
// via unverified email) is explicit.
const KEY_OKTA_ALLOW_UNVERIFIED = 'okta_allow_unverified_email'
export async function isOktaAllowUnverifiedEmail(): Promise<boolean> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_OKTA_ALLOW_UNVERIFIED)).limit(1)
    const val = row?.value as { enabled?: boolean } | undefined
    return Boolean(val?.enabled)
  } catch {
    return false
  }
}
export async function setOktaAllowUnverifiedEmail(enabled: boolean): Promise<void> {
  await upsert(KEY_OKTA_ALLOW_UNVERIFIED, { enabled })
}

// v1.106.0: public base URL used to build hosted image URLs for
// outbound emails (theme logos + brand assets). Set once by the app
// admin; must be reachable by external mail clients (i.e. the address
// Outlook sees in the "From" domain trust list). Falls back to the
// APP_URL env var when unset. Empty/null disables the hosted-URL
// path — the renderer falls back to CID inline attachments.
const KEY_APP_PUBLIC_BASE_URL = 'app_public_base_url'
export async function getPublicBaseUrl(): Promise<string | null> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_APP_PUBLIC_BASE_URL)).limit(1)
    const val = row?.value as { url?: string } | undefined
    const stored = (val?.url ?? '').trim().replace(/\/+$/, '')
    if (stored) return stored
    const envUrl = (process.env['APP_URL'] ?? '').trim().replace(/\/+$/, '')
    return envUrl || null
  } catch {
    const envUrl = (process.env['APP_URL'] ?? '').trim().replace(/\/+$/, '')
    return envUrl || null
  }
}
export async function setPublicBaseUrl(url: string | null): Promise<void> {
  const cleaned = (url ?? '').trim().replace(/\/+$/, '')
  await upsert(KEY_APP_PUBLIC_BASE_URL, { url: cleaned })
}

// Support contact email shown on pre-auth screens (Login/Setup/Forgot/Reset
// Password) and the in-app header help icon. Genuinely optional — unset by
// default, in which case the callers hide the icon entirely rather than
// linking to a dead/placeholder address. DB preferred, SUPPORT_EMAIL env
// fallback for ops convenience, same pattern as the rest of this file.
const KEY_SUPPORT_EMAIL = 'support_email'
export async function getSupportEmail(): Promise<string | null> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_SUPPORT_EMAIL)).limit(1)
    const val = row?.value as { email?: string } | undefined
    const stored = (val?.email ?? '').trim()
    if (stored) return stored
    const envEmail = (process.env['SUPPORT_EMAIL'] ?? '').trim()
    return envEmail || null
  } catch {
    const envEmail = (process.env['SUPPORT_EMAIL'] ?? '').trim()
    return envEmail || null
  }
}
export async function setSupportEmail(email: string | null): Promise<void> {
  const cleaned = (email ?? '').trim()
  await upsert(KEY_SUPPORT_EMAIL, { email: cleaned })
}

// App-wide login screen logo — the large graphic above the sign-in card on
// every pre-auth page (Login/Forgot/Reset Password). Optional and unset by
// default: when empty, AuthShell falls back to the active theme's own logo,
// so an install that never touches this keeps exactly today's behavior. No
// vendor graphic is ever seeded here. Stored as an image data URI in
// system_settings (same key-value table as support_email above), validated
// against the theme-logo MIME allowlist by the admin PUT route.
const KEY_LOGIN_LOGO = 'login_logo'
// width/height are optional px overrides for the logo's bounding box on the
// login screen; null means "default by the image's shape" (see
// src/shared/loginLogoSize.ts). They live in the same row as the image.
export interface LoginLogoConfig { dataUrl: string | null; width: number | null; height: number | null }
async function readLoginLogoConfig(): Promise<LoginLogoConfig> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_LOGIN_LOGO)).limit(1)
    const val = row?.value as { dataUrl?: string | null; width?: unknown; height?: unknown } | undefined
    const stored = (val?.dataUrl ?? '').trim()
    return {
      dataUrl: stored || null,
      width: normalizeLoginLogoDimension(val?.width),
      height: normalizeLoginLogoDimension(val?.height),
    }
  } catch {
    return { dataUrl: null, width: null, height: null }
  }
}
export async function getLoginLogoConfig(): Promise<LoginLogoConfig> {
  return readLoginLogoConfig()
}
export async function getLoginLogo(): Promise<string | null> {
  return (await readLoginLogoConfig()).dataUrl
}
// Partial update: only the keys present in `patch` change, so saving a new
// size never wipes the image and replacing the image keeps the size.
export async function setLoginLogoConfig(patch: Partial<LoginLogoConfig>): Promise<void> {
  const current = await readLoginLogoConfig()
  await upsert(KEY_LOGIN_LOGO, {
    dataUrl: 'dataUrl' in patch ? patch.dataUrl ?? null : current.dataUrl,
    width: 'width' in patch ? normalizeLoginLogoDimension(patch.width) : current.width,
    height: 'height' in patch ? normalizeLoginLogoDimension(patch.height) : current.height,
  })
}
export async function setLoginLogo(dataUrl: string | null): Promise<void> {
  await setLoginLogoConfig({ dataUrl })
}

// SF internal-domain filter for attendee-based suggestions
const KEY_SF_INTERNAL_DOMAINS = 'sf_internal_domains'
const DEFAULT_INTERNAL_DOMAINS: string[] = []

export async function getSfInternalDomains(): Promise<string[]> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_SF_INTERNAL_DOMAINS)).limit(1)
    const val = row?.value as { domains?: string[] } | undefined
    if (!val?.domains || val.domains.length === 0) return DEFAULT_INTERNAL_DOMAINS
    return val.domains.map((d) => d.toLowerCase().replace(/^@/, '').trim()).filter(Boolean)
  } catch {
    return DEFAULT_INTERNAL_DOMAINS
  }
}
export async function setSfInternalDomains(domains: string[]): Promise<void> {
  const cleaned = domains.map((d) => d.toLowerCase().replace(/^@/, '').trim()).filter(Boolean)
  await upsert(KEY_SF_INTERNAL_DOMAINS, { domains: cleaned })
}

// v1.215.0: historical-import estimate settings.
//
// Salesforce reports all-day Events as 1440 minutes (or null), so the raw
// value would make any hours total absurd. The cap is what we substitute
// instead — a guess either way, so an admin gets to choose it.
const KEY_HIST_ALL_DAY_CAP = 'historical_all_day_cap_hours'
const KEY_HIST_RECOMPUTE_NEEDED = 'historical_recompute_needed'
export const DEFAULT_ALL_DAY_CAP_HOURS = 8

export async function getHistoricalAllDayCapHours(): Promise<number> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_HIST_ALL_DAY_CAP)).limit(1)
    const val = row?.value as { hours?: number } | undefined
    const n = Number(val?.hours)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_ALL_DAY_CAP_HOURS
    return Math.min(Math.max(n, 0.25), 24)
  } catch {
    return DEFAULT_ALL_DAY_CAP_HOURS
  }
}

export async function setHistoricalAllDayCapHours(hours: number): Promise<void> {
  const clamped = Math.round(Math.min(Math.max(hours, 0.25), 24) * 100) / 100
  // v1.222.0: only flag a recompute when the value ACTUALLY moves. The admin
  // page saves the cap and the import window together, so an unconditional
  // flag lit up "Estimates stale" every time someone changed the window —
  // prompting a pointless 48k-row relink for a setting that doesn't affect
  // estimates at all.
  const current = await getHistoricalAllDayCapHours()
  await upsert(KEY_HIST_ALL_DAY_CAP, { hours: clamped })
  if (current === clamped) return
  // estimated_hours is a stored column (six SQL aggregation sites read it), so
  // changing the cap leaves existing rows stale. Flag it rather than running a
  // 48k-row recompute inline on an HTTP request — the admin may also want to
  // change type mappings before triggering one pass.
  await upsert(KEY_HIST_RECOMPUTE_NEEDED, { needed: true })
}

// v1.222.0: how far back the historical import walks. Capped at 3 years,
// which is the scope the SOQL query was designed and measured against. An org
// whose usable Salesforce Event data only goes back two years shouldn't pay to
// walk a third year of rows it will discard — the backfill is the expensive
// part of this feature, so shortening it is the main lever an admin has.
const KEY_HIST_LOOKBACK_DAYS = 'historical_lookback_days'
export const DEFAULT_HIST_LOOKBACK_DAYS = 1095 // 3 years
export const MAX_HIST_LOOKBACK_DAYS = 1095
export const MIN_HIST_LOOKBACK_DAYS = 30

export async function getHistoricalLookbackDays(): Promise<number> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_HIST_LOOKBACK_DAYS)).limit(1)
    const n = Number((row?.value as { days?: number } | undefined)?.days)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_HIST_LOOKBACK_DAYS
    return Math.min(Math.max(Math.round(n), MIN_HIST_LOOKBACK_DAYS), MAX_HIST_LOOKBACK_DAYS)
  } catch {
    return DEFAULT_HIST_LOOKBACK_DAYS
  }
}

export async function setHistoricalLookbackDays(days: number): Promise<void> {
  const clamped = Math.min(Math.max(Math.round(days), MIN_HIST_LOOKBACK_DAYS), MAX_HIST_LOOKBACK_DAYS)
  await upsert(KEY_HIST_LOOKBACK_DAYS, { days: clamped })
  // Deliberately does NOT move an existing floor. The cursor and floorAt live
  // in crm_historical_backfill_state, and silently rewriting them would either
  // abandon rows already imported or re-walk ground already covered. A changed
  // window takes effect on the next Reset cursor, and the admin page says so.
}

// A fixed earliest date, as an alternative to the relative window above. The
// two behave differently and that difference is the point: "2 years" keeps
// sliding forward as time passes, whereas "2024-08-01" stays put. An admin who
// knows their Salesforce data is only trustworthy after a specific migration
// or go-live date wants the second, and expressing that as a day count would
// mean re-deriving it every time they reset.
//
// When set, this WINS over lookbackDays — lookbackDays is kept rather than
// overwritten so switching back to a preset restores the previous choice.
const KEY_HIST_EARLIEST_DATE = 'historical_earliest_date'

/** YYYY-MM-DD, interpreted as UTC midnight. */
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/

const DAY_MS = 24 * 60 * 60 * 1000

/** Parses YYYY-MM-DD as UTC midnight. Returns null on anything else. */
export function parseIsoDateUtc(s: string): Date | null {
  if (!ISO_DATE_RX.test(s)) return null
  const d = new Date(`${s}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The bounds a fixed earliest date has to fall inside, as of now. */
export function historicalEarliestDateBounds(now = new Date()): { min: Date; max: Date } {
  return {
    // Oldest allowed — same 3-year scope the SOQL query was measured against.
    min: new Date(now.getTime() - MAX_HIST_LOOKBACK_DAYS * DAY_MS),
    // Newest allowed — a window under 30 days isn't worth a backfill.
    max: new Date(now.getTime() - MIN_HIST_LOOKBACK_DAYS * DAY_MS),
  }
}

export async function getHistoricalEarliestDate(): Promise<string | null> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_HIST_EARLIEST_DATE)).limit(1)
    const raw = (row?.value as { date?: string | null } | undefined)?.date
    if (typeof raw !== 'string' || !parseIsoDateUtc(raw)) return null
    return raw
  } catch {
    return null
  }
}

/** Pass null to clear it and fall back to the relative window. */
export async function setHistoricalEarliestDate(date: string | null): Promise<void> {
  await upsert(KEY_HIST_EARLIEST_DATE, { date: date && parseIsoDateUtc(date) ? date : null })
}

export interface HistoricalImportWindow {
  lookbackDays: number
  /** Null when the relative window is in effect. */
  earliestDate: string | null
  /** The floor the next reset would use, after clamping. */
  floorAt: Date
  /** True when the stored fixed date has aged past the 3-year cap. */
  clamped: boolean
}

/**
 * The effective import floor. A fixed date wins when set, but is still clamped
 * to the 3-year cap — a date saved two years ago eventually drifts outside the
 * scope the query was measured against, and quietly widening it there would be
 * worse than pulling it forward and saying so.
 */
export async function getHistoricalImportWindow(now = new Date()): Promise<HistoricalImportWindow> {
  const [lookbackDays, earliestDate] = await Promise.all([
    getHistoricalLookbackDays(),
    getHistoricalEarliestDate(),
  ])
  if (!earliestDate) {
    return { lookbackDays, earliestDate: null, floorAt: new Date(now.getTime() - lookbackDays * DAY_MS), clamped: false }
  }
  const parsed = parseIsoDateUtc(earliestDate)!
  const { min, max } = historicalEarliestDateBounds(now)
  const floorAt = parsed < min ? min : parsed > max ? max : parsed
  return { lookbackDays, earliestDate, floorAt, clamped: floorAt.getTime() !== parsed.getTime() }
}

export async function isHistoricalRecomputeNeeded(): Promise<boolean> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_HIST_RECOMPUTE_NEEDED)).limit(1)
    return (row?.value as { needed?: boolean } | undefined)?.needed === true
  } catch {
    return false
  }
}

export async function clearHistoricalRecomputeNeeded(): Promise<void> {
  await upsert(KEY_HIST_RECOMPUTE_NEEDED, { needed: false })
}

export interface SfIntegrationConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  loginUrl: string
}

export interface MsIntegrationConfig {
  clientId: string
  clientSecret: string
  tenantId: string
}

export interface OktaIntegrationConfig {
  domain: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

// Azure AD / Entra ID SSO (OIDC login provider — distinct from Azure OpenAI).
export interface AzureSsoIntegrationConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  redirectUri: string
  // User Provisioning Rule: true = JIT auto-provision on first login;
  // false = the user must already exist in ImpactIQ.
  allowJit: boolean
}

// Unified email configuration: admin picks either SMTP relay or Microsoft
// Graph App-Only (sendMail) at the system level. Per-user transport choice
// is no longer needed — the digest worker uses whichever is configured.
export type EmailIntegrationConfig =
  | {
      authMethod: 'smtp'
      host: string
      port: number
      username: string
      password: string
      fromAddress: string
      replyToAddress: string | null
      secure: boolean
    }
  | {
      authMethod: 'graph_app'
      tenantId: string
      clientId: string
      clientSecret: string
      senderMailbox: string
      fromAddress: string
      replyToAddress: string | null
    }

// Back-compat alias used by older callers — points at the unified shape.
export type SmtpIntegrationConfig = EmailIntegrationConfig

interface SfStored { clientId: string; clientSecretEncrypted: string; redirectUri: string; loginUrl: string }
interface MsStored { clientId: string; clientSecretEncrypted: string; tenantId: string }
interface OktaStored { domain: string; clientId: string; clientSecretEncrypted: string; redirectUri: string }
interface AzureSsoStored { tenantId: string; clientId: string; clientSecretEncrypted: string; redirectUri: string; allowJit: boolean }
type EmailStored =
  | {
      authMethod: 'smtp'
      host: string
      port: number
      username: string
      passwordEncrypted: string
      fromAddress: string
      replyToAddress: string | null
      secure: boolean
    }
  | {
      authMethod: 'graph_app'
      tenantId: string
      clientId: string
      clientSecretEncrypted: string
      senderMailbox: string
      fromAddress: string
      replyToAddress: string | null
    }
  // Legacy shape (no authMethod) → treat as SMTP
  | {
      host: string
      port: number
      username: string
      passwordEncrypted: string
      fromAddress: string
      secure: boolean
      authMethod?: undefined
    }

// In-memory runtime config — DB preferred, env fallback
let sfCfg: SfIntegrationConfig | null = null
let msCfg: MsIntegrationConfig | null = null
let oktaCfg: OktaIntegrationConfig | null = null
let azureSsoCfg: AzureSsoIntegrationConfig | null = null
let emailCfg: EmailIntegrationConfig | null = null

function emailFromEnv(): EmailIntegrationConfig | null {
  const host = process.env['SMTP_HOST']
  const port = process.env['SMTP_PORT']
  const username = process.env['SMTP_USER']
  const password = process.env['SMTP_PASS']
  const fromAddress = process.env['SMTP_FROM']
  if (!host || !port || !username || !password || !fromAddress) return null
  return {
    authMethod: 'smtp',
    host,
    port: Number(port),
    username,
    password,
    fromAddress,
    replyToAddress: process.env['SMTP_REPLY_TO'] ?? null,
    secure: process.env['SMTP_SECURE'] === 'true',
  }
}

function sfFromEnv(): SfIntegrationConfig | null {
  const clientId = process.env['SF_CLIENT_ID']
  const clientSecret = process.env['SF_CLIENT_SECRET']
  const redirectUri = process.env['SF_REDIRECT_URI']
  if (!clientId || !clientSecret || !redirectUri) return null
  return { clientId, clientSecret, redirectUri, loginUrl: process.env['SF_LOGIN_URL'] ?? 'https://login.salesforce.com' }
}

function msFromEnv(): MsIntegrationConfig | null {
  const clientId = process.env['MS_CLIENT_ID']
  const clientSecret = process.env['MS_CLIENT_SECRET']
  const tenantId = process.env['MS_TENANT_ID']
  if (!clientId || !clientSecret || !tenantId) return null
  return { clientId, clientSecret, tenantId }
}

function oktaFromEnv(): OktaIntegrationConfig | null {
  const domain = process.env['OKTA_DOMAIN']
  const clientId = process.env['OKTA_CLIENT_ID']
  const clientSecret = process.env['OKTA_CLIENT_SECRET']
  const redirectUri = process.env['OKTA_REDIRECT_URI']
  if (!domain || !clientId || !clientSecret || !redirectUri) return null
  return { domain, clientId, clientSecret, redirectUri }
}

function azureSsoFromEnv(): AzureSsoIntegrationConfig | null {
  const tenantId = process.env['AZURE_SSO_TENANT_ID']
  const clientId = process.env['AZURE_SSO_CLIENT_ID']
  const clientSecret = process.env['AZURE_SSO_CLIENT_SECRET']
  const redirectUri = process.env['AZURE_SSO_REDIRECT_URI']
  if (!tenantId || !clientId || !clientSecret || !redirectUri) return null
  return { tenantId, clientId, clientSecret, redirectUri, allowJit: process.env['AZURE_SSO_ALLOW_JIT'] === 'true' }
}

async function upsert(key: string, value: unknown): Promise<void> {
  const existing = await db.select({ key: systemSettings.key }).from(systemSettings).where(eq(systemSettings.key, key)).limit(1)
  if (existing.length > 0) {
    await db.update(systemSettings).set({ value: value as Record<string, unknown> }).where(eq(systemSettings.key, key))
  } else {
    await db.insert(systemSettings).values({ key, value: value as Record<string, unknown> })
  }
}

export async function loadIntegrationConfigs(): Promise<void> {
  try {
    const rows = await db.select().from(systemSettings).where(
      inArray(systemSettings.key, [KEY_SF, KEY_MS, KEY_OKTA, KEY_AZURE_SSO, KEY_EMAIL])
    )
    for (const row of rows) {
      // Per-row: one value that won't decrypt (e.g. a database restored from
      // an install with a different TOKEN_ENCRYPTION_KEY) must not stop the
      // other integrations from loading.
      try {
      if (row.key === KEY_SF) {
        const s = row.value as SfStored
        sfCfg = { clientId: s.clientId, clientSecret: decryptToken(s.clientSecretEncrypted), redirectUri: s.redirectUri, loginUrl: s.loginUrl }
      } else if (row.key === KEY_MS) {
        const s = row.value as MsStored
        msCfg = { clientId: s.clientId, clientSecret: decryptToken(s.clientSecretEncrypted), tenantId: s.tenantId }
      } else if (row.key === KEY_OKTA) {
        const s = row.value as OktaStored
        oktaCfg = { domain: s.domain, clientId: s.clientId, clientSecret: decryptToken(s.clientSecretEncrypted), redirectUri: s.redirectUri }
      } else if (row.key === KEY_AZURE_SSO) {
        const s = row.value as AzureSsoStored
        azureSsoCfg = { tenantId: s.tenantId, clientId: s.clientId, clientSecret: decryptToken(s.clientSecretEncrypted), redirectUri: s.redirectUri, allowJit: Boolean(s.allowJit) }
      } else if (row.key === KEY_EMAIL) {
        const s = row.value as EmailStored
        if (s.authMethod === 'graph_app') {
          emailCfg = {
            authMethod: 'graph_app',
            tenantId: s.tenantId,
            clientId: s.clientId,
            clientSecret: decryptToken(s.clientSecretEncrypted),
            senderMailbox: s.senderMailbox,
            fromAddress: s.fromAddress,
            replyToAddress: s.replyToAddress ?? null,
          }
        } else {
          // 'smtp' or legacy shape with no authMethod
          emailCfg = {
            authMethod: 'smtp',
            host: s.host,
            port: s.port,
            username: s.username,
            password: decryptToken(s.passwordEncrypted),
            fromAddress: s.fromAddress,
            replyToAddress: 'replyToAddress' in s ? (s.replyToAddress ?? null) : null,
            secure: s.secure,
          }
        }
      }
      } catch (err) {
        console.warn(`[integrations] Could not load ${row.key} from DB (falling back to env):`, err)
      }
    }
  } catch (err) {
    console.warn('[integrations] Failed to load integration config from DB:', err)
  }
  // Fall back to env vars for any that weren't in DB
  if (!sfCfg) sfCfg = sfFromEnv()
  if (!msCfg) msCfg = msFromEnv()
  if (!oktaCfg) oktaCfg = oktaFromEnv()
  if (!azureSsoCfg) azureSsoCfg = azureSsoFromEnv()
  if (!emailCfg) emailCfg = emailFromEnv()
}

// Re-reads every integration from the database from scratch — used after a
// full database restore (services/backup) replaces system_settings, so the
// in-memory copies loaded at boot don't keep serving the old values.
export async function reloadIntegrationConfigs(): Promise<void> {
  sfCfg = null
  msCfg = null
  oktaCfg = null
  azureSsoCfg = null
  emailCfg = null
  await loadIntegrationConfigs()
}

export function getSfIntegrationConfig(): SfIntegrationConfig | null { return sfCfg }
export function getMsIntegrationConfig(): MsIntegrationConfig | null { return msCfg }
export function getOktaIntegrationConfig(): OktaIntegrationConfig | null { return oktaCfg }
export function getAzureSsoIntegrationConfig(): AzureSsoIntegrationConfig | null { return azureSsoCfg }
export function getEmailIntegrationConfig(): EmailIntegrationConfig | null { return emailCfg }
// Back-compat alias for older callers
export function getSmtpIntegrationConfig(): EmailIntegrationConfig | null { return emailCfg }

export async function saveEmailIntegrationConfig(cfg: EmailIntegrationConfig): Promise<void> {
  let stored: EmailStored
  if (cfg.authMethod === 'graph_app') {
    stored = {
      authMethod: 'graph_app',
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecretEncrypted: encryptToken(cfg.clientSecret),
      senderMailbox: cfg.senderMailbox,
      fromAddress: cfg.fromAddress,
      replyToAddress: cfg.replyToAddress,
    }
  } else {
    stored = {
      authMethod: 'smtp',
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      passwordEncrypted: encryptToken(cfg.password),
      fromAddress: cfg.fromAddress,
      replyToAddress: cfg.replyToAddress,
      secure: cfg.secure,
    }
  }
  await upsert(KEY_EMAIL, stored)
  emailCfg = cfg
}

export async function clearEmailIntegrationConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY_EMAIL))
  emailCfg = emailFromEnv()
}

// Back-compat aliases for older callers
export const saveSmtpIntegrationConfig = saveEmailIntegrationConfig
export const clearSmtpIntegrationConfig = clearEmailIntegrationConfig

export async function saveSfIntegrationConfig(cfg: SfIntegrationConfig): Promise<void> {
  const stored: SfStored = { clientId: cfg.clientId, clientSecretEncrypted: encryptToken(cfg.clientSecret), redirectUri: cfg.redirectUri, loginUrl: cfg.loginUrl }
  await upsert(KEY_SF, stored)
  sfCfg = cfg
}

export async function saveMsIntegrationConfig(cfg: MsIntegrationConfig): Promise<void> {
  const stored: MsStored = { clientId: cfg.clientId, clientSecretEncrypted: encryptToken(cfg.clientSecret), tenantId: cfg.tenantId }
  await upsert(KEY_MS, stored)
  msCfg = cfg
}

export async function saveOktaIntegrationConfig(cfg: OktaIntegrationConfig): Promise<void> {
  const stored: OktaStored = { domain: cfg.domain, clientId: cfg.clientId, clientSecretEncrypted: encryptToken(cfg.clientSecret), redirectUri: cfg.redirectUri }
  await upsert(KEY_OKTA, stored)
  oktaCfg = cfg
}

export async function clearSfIntegrationConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY_SF))
  sfCfg = sfFromEnv()
}

export async function clearMsIntegrationConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY_MS))
  msCfg = msFromEnv()
}

export async function clearOktaIntegrationConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY_OKTA))
  oktaCfg = oktaFromEnv()
}

export async function saveAzureSsoIntegrationConfig(cfg: AzureSsoIntegrationConfig): Promise<void> {
  const stored: AzureSsoStored = { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecretEncrypted: encryptToken(cfg.clientSecret), redirectUri: cfg.redirectUri, allowJit: cfg.allowJit }
  await upsert(KEY_AZURE_SSO, stored)
  azureSsoCfg = cfg
}

export async function clearAzureSsoIntegrationConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY_AZURE_SSO))
  azureSsoCfg = azureSsoFromEnv()
}

// Returns masked config (secrets replaced with boolean) for the admin UI
export function getIntegrationConfigSummary() {
  return {
    salesforce: sfCfg ? {
      source: sfFromEnv()?.clientId === sfCfg.clientId && sfFromEnv()?.clientSecret === sfCfg.clientSecret ? 'env' : 'db',
      clientId: sfCfg.clientId,
      redirectUri: sfCfg.redirectUri,
      loginUrl: sfCfg.loginUrl,
      hasSecret: true,
    } : null,
    microsoft: msCfg ? {
      source: msFromEnv()?.clientId === msCfg.clientId ? 'env' : 'db',
      clientId: msCfg.clientId,
      tenantId: msCfg.tenantId,
      hasSecret: true,
    } : null,
    okta: oktaCfg ? {
      source: oktaFromEnv()?.clientId === oktaCfg.clientId ? 'env' : 'db',
      domain: oktaCfg.domain,
      clientId: oktaCfg.clientId,
      redirectUri: oktaCfg.redirectUri,
      hasSecret: true,
    } : null,
    azureSso: azureSsoCfg ? {
      source: azureSsoFromEnv()?.clientId === azureSsoCfg.clientId ? 'env' : 'db',
      tenantId: azureSsoCfg.tenantId,
      clientId: azureSsoCfg.clientId,
      redirectUri: azureSsoCfg.redirectUri,
      allowJit: azureSsoCfg.allowJit,
      hasSecret: true,
    } : null,
    // Storage key is still called "smtp" for backward compatibility with the
    // older admin UI; the value now describes either SMTP or Graph App-Only.
    smtp: emailCfg ? (emailCfg.authMethod === 'graph_app' ? {
      source: 'db',
      authMethod: 'graph_app' as const,
      fromAddress: emailCfg.fromAddress,
      replyToAddress: emailCfg.replyToAddress,
      tenantId: emailCfg.tenantId,
      clientId: emailCfg.clientId,
      senderMailbox: emailCfg.senderMailbox,
      hasSecret: true,
    } : {
      source: (() => {
        const env = emailFromEnv()
        return env?.authMethod === 'smtp' && env.host === emailCfg.host ? 'env' : 'db'
      })(),
      authMethod: 'smtp' as const,
      host: emailCfg.host,
      port: emailCfg.port,
      username: emailCfg.username,
      fromAddress: emailCfg.fromAddress,
      replyToAddress: emailCfg.replyToAddress,
      secure: emailCfg.secure,
      hasPassword: true,
    }) : null,
  }
}
