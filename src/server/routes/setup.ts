import { Router } from 'express'
import postgres from 'postgres'
import { applyMigrations } from '../db/migrator.js'
import { sql } from 'drizzle-orm'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { assertSalesforceLoginUrl } from '../services/net/ssrfGuard.js'
import { safeFetch } from '../services/net/safeFetch.js'
import { z } from 'zod'
import { isDbConfigured, findMigrationsFolder } from '../db/index.js'
import { hashPassword } from '../services/auth/password.js'
import { validatePasswordComplexity } from '../../shared/schemas/password.js'
import { CRM_PROVIDER_IDS, crmProviderChangeAllowed, normalizeCrmProviderSetting } from '../../shared/crmProvider.js'
import { AI_PROVIDER_DEFAULT_NAMES, AI_PROVIDER_KIND_INFO, AI_SETUP_PROVIDER_KINDS, type AiProviderField } from '../../shared/ai.js'

export const setupRouter = Router()

// Setup routes are ONLY available when DATABASE_URL is unset.
// Once configured, every endpoint returns 404 — preventing post-install abuse.
setupRouter.use((_req, res, next) => {
  if (isDbConfigured()) {
    res.status(404).json({ data: null, error: 'errors.setup.already_complete', meta: {} })
    return
  }
  next()
})

// Security audit L9 (v1.425.0): before DATABASE_URL is set the wizard is
// reachable by anyone who can reach the server, and its database test can be
// pointed at internal hosts. Every route but /status needs the one-time setup
// token, printed to the server log at startup (or SETUP_TOKEN, when set).
const SETUP_TOKEN_HEADER = 'x-setup-token'
let setupToken: string | null = null

export function getOrCreateSetupToken(): { token: string; fromEnv: boolean } {
  const fromEnv = process.env['SETUP_TOKEN']?.trim() ?? ''
  if (fromEnv.length >= 16) return { token: fromEnv, fromEnv: true }
  if (!setupToken) setupToken = randomBytes(24).toString('base64url')
  return { token: setupToken, fromEnv: false }
}

function digest(v: string): Buffer {
  return createHash('sha256').update(v).digest()
}

export function setupTokenMatches(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw === '') return false
  return timingSafeEqual(digest(raw.trim()), digest(getOrCreateSetupToken().token))
}

setupRouter.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/status') { next(); return }
  if (!setupTokenMatches(req.headers[SETUP_TOKEN_HEADER])) {
    res.status(401).json({ data: null, error: 'errors.setup.token_invalid', meta: {} })
    return
  }
  next()
})

// POST /api/setup/verify-token — the wizard's first screen checks the token
// before showing step 1. Reaching here means the middleware above accepted it.
setupRouter.post('/verify-token', (_req, res) => {
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// GET /api/setup/status
setupRouter.get('/status', (_req, res) => {
  res.json({
    data: {
      needsSetup: true,
      tokenRequired: true,
      appUrlPresent: !!process.env['APP_URL'],
      tokenKeyPresent: !!process.env['TOKEN_ENCRYPTION_KEY'],
    },
    error: null,
    meta: {},
  })
})

// GET /api/setup/generate-key
setupRouter.get('/generate-key', (_req, res) => {
  const key = randomBytes(32).toString('hex')
  res.json({ data: { key }, error: null, meta: {} })
})

const DbUrlSchema = z.object({
  databaseUrl: z.string().min(10).refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'Must start with postgres:// or postgresql://',
  }),
})

// POST /api/setup/test-db
setupRouter.post('/test-db', async (req, res) => {
  const parsed = DbUrlSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? 'Invalid input', meta: {} })
    return
  }

  const start = Date.now()
  let client: ReturnType<typeof postgres> | null = null
  try {
    client = postgres(parsed.data.databaseUrl, { connect_timeout: 8, max: 1, onnotice: () => {} })
    const result = await client`SELECT version() as version, current_database() as database`
    const elapsed = Date.now() - start

    // Detect whether our schema is already installed
    const tables = await client`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('teams', 'users', 'activities')
    `
    const schemaInstalled = tables.length >= 3
    // v1.247.0: schemaInstalled only proves the TABLES exist — it says
    // nothing about whether seeding ever ran. A prior setup attempt can
    // commit migrations and then fail (or be skipped) partway through
    // seeding, leaving an empty `teams` table; the wizard's Next-button
    // gate was checking schemaInstalled alone, so it let an admin reach
    // Step 2 with nothing for create-admin to attach to — see
    // errors.setup.team_not_found. Report team existence separately so the
    // client can gate on the thing Step 2 actually needs.
    let hasTeam = false
    if (schemaInstalled) {
      const teamRows = await client`SELECT count(*)::int as n FROM teams`
      hasTeam = Number(teamRows[0]?.['n'] ?? 0) > 0
    }

    res.json({
      data: {
        ok: true,
        latencyMs: elapsed,
        version: String(result[0]?.['version'] ?? '').split(' ')[1] ?? 'unknown',
        database: result[0]?.['database'],
        schemaInstalled,
        hasTeam,
      },
      error: null,
      meta: {},
    })
  } catch (err) {
    res.status(400).json({
      data: { ok: false },
      error: err instanceof Error ? err.message : 'Connection failed',
      meta: {},
    })
  } finally {
    if (client) await client.end({ timeout: 2 }).catch(() => {})
  }
})

// POST /api/setup/migrate
// Runs migrations + seed against the supplied DATABASE_URL.
setupRouter.post('/migrate', async (req, res) => {
  const parsed = DbUrlSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? 'Invalid input', meta: {} })
    return
  }

  const log: string[] = []
  let client: ReturnType<typeof postgres> | null = null
  try {
    client = postgres(parsed.data.databaseUrl, { max: 1, onnotice: () => {} })

    log.push('Connecting to database...')
    await client`SELECT 1`
    log.push('✓ Connected')

    // v1.246.0: was `resolve(process.cwd(), 'drizzle/migrations')` on the
    // (incorrect) assumption that cwd is always the repo root — true for
    // `docker compose up` and production, but not for `npm run dev
    // --workspace=src/server` (cwd = src/server), where this silently
    // pointed at a folder that doesn't exist. findMigrationsFolder() walks
    // up from db/index.ts's own file location instead, so it's correct
    // regardless of the caller's cwd or how deep tsc nests the build output.
    const migrationsFolder = findMigrationsFolder()
    log.push(`Running migrations from ${migrationsFolder}...`)
    await applyMigrations(client, migrationsFolder)
    log.push('✓ Migrations applied')

    // Seed if empty
    const existing = await client`SELECT count(*)::int as n FROM teams`
    const teamCount = Number(existing[0]?.['n'] ?? 0)
    if (teamCount === 0) {
      log.push('Database empty — running seed...')
      // Temporarily set DATABASE_URL for the seed script
      const prevUrl = process.env['DATABASE_URL']
      process.env['DATABASE_URL'] = parsed.data.databaseUrl
      try {
        const { runSeed } = await import('../../../drizzle/seed.js')
        await runSeed()
        log.push('✓ Seed data inserted (Sales Engineering team, activity types, rules)')
      } finally {
        if (prevUrl === undefined) delete process.env['DATABASE_URL']
        else process.env['DATABASE_URL'] = prevUrl
      }
    } else {
      log.push(`✓ Database already has ${teamCount} team(s) — seed skipped`)
    }

    res.json({ data: { ok: true, log }, error: null, meta: {} })
  } catch (err) {
    log.push(`✗ ${err instanceof Error ? err.message : String(err)}`)
    res.status(500).json({ data: { ok: false, log }, error: err instanceof Error ? err.message : 'Migration failed', meta: {} })
  } finally {
    if (client) await client.end({ timeout: 2 }).catch(() => {})
  }
})

const AdminSchema = z.object({
  databaseUrl: z.string().min(10).refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://')),
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(1, 'Password is required'),
})

// POST /api/setup/create-admin
// Creates the initial admin user and grants them admin on the default team.
// Idempotent: if a user with that email already exists, ensures they hold admin
// on the default team and returns the existing record.
setupRouter.post('/create-admin', async (req, res) => {
  const parsed = AdminSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? 'Invalid input', meta: {} })
    return
  }

  // This account is granted App Admin outright (see the INSERT below), so it
  // gets the same complexity floor every other password-write path in the
  // app already enforces (services/auth/passwordPolicy.ts, the admin reset
  // route, self-service change) — previously this route only checked
  // length >= 8, letting the very first, highest-privileged account in the
  // system be created with a weaker password than any account created
  // afterward.
  const complexity = validatePasswordComplexity(parsed.data.password)
  if (!complexity.ok) {
    res.status(400).json({ data: null, error: `Password must satisfy: ${complexity.failedLabels.join(', ')}`, meta: {} })
    return
  }

  let client: ReturnType<typeof postgres> | null = null
  try {
    client = postgres(parsed.data.databaseUrl, { max: 1, onnotice: () => {} })

    const passwordHash = hashPassword(parsed.data.password)
    const existing = await client`SELECT id FROM users WHERE email = ${parsed.data.email} LIMIT 1`
    let userId = existing[0]?.['id'] as string | undefined

    if (!userId) {
      const inserted = await client`
        INSERT INTO users (okta_id, email, display_name, password_hash, is_app_admin, can_see_all_teams)
        VALUES (${'bootstrap:' + parsed.data.email}, ${parsed.data.email}, ${parsed.data.displayName}, ${passwordHash}, true, true)
        RETURNING id
      `
      userId = inserted[0]?.['id'] as string
    } else {
      await client`UPDATE users SET password_hash = ${passwordHash}, display_name = ${parsed.data.displayName}, is_app_admin = true, can_see_all_teams = true WHERE id = ${userId}`
    }
    // v1.475.0: the account that sets up the install is its default admin
    // (App Updates and similar controls need one) unless one already exists.
    await client`UPDATE users SET is_default_admin = true WHERE id = ${userId!} AND NOT EXISTS (SELECT 1 FROM users WHERE is_default_admin)`

    // v1.247.0: was a hard 400 (errors.setup.team_not_found) if `teams` was
    // empty — but is_app_admin + can_see_all_teams (set unconditionally
    // above) already grant this account every team with zero dependency on
    // any team_members row: getAccessibleTeamIds() (rbac.ts) and GET
    // /api/teams (routes/teams.ts) both branch on isAppAdmin/canSeeAllTeams
    // and return every active team, synthesizing role='admin', before they
    // ever look at team_members. A team_members row here is a "home team"
    // nicety, never a requirement for this account to work — so a missing
    // team must never block admin creation. Best-effort only: try to seed
    // if none exists yet (covers a prior attempt that committed migrations
    // but never successfully seeded), but the account is already created
    // and fully functional either way by the time we get here.
    let teamRows = await client`SELECT id FROM teams ORDER BY created_at ASC LIMIT 1`
    let teamId = teamRows[0]?.['id']
    if (!teamId) {
      const prevUrl = process.env['DATABASE_URL']
      process.env['DATABASE_URL'] = parsed.data.databaseUrl
      try {
        const { runSeed } = await import('../../../drizzle/seed.js')
        await runSeed()
        teamRows = await client`SELECT id FROM teams ORDER BY created_at ASC LIMIT 1`
        teamId = teamRows[0]?.['id']
      } catch {
        // Best-effort — leave teamId unset; the account above is already
        // created and fully functional via is_app_admin regardless.
      } finally {
        if (prevUrl === undefined) delete process.env['DATABASE_URL']
        else process.env['DATABASE_URL'] = prevUrl
      }
    }

    if (teamId) {
      await client`
        INSERT INTO team_members (team_id, user_id, role)
        VALUES (${teamId}, ${userId!}, 'admin')
        ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'admin'
      `
    }

    res.json({ data: { ok: true, userId, email: parsed.data.email }, error: null, meta: {} })
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : 'Failed to create admin', meta: {} })
  } finally {
    if (client) await client.end({ timeout: 2 }).catch(() => {})
  }
})

// POST /api/setup/crm-provider
// Saves which CRM this install uses (system_settings.crm_provider, the same
// row Admin → Integrations edits later). Applies the same lock as the admin
// route: when the database already holds CRM-linked records, the install may
// only stay on that data's CRM or choose "none".
const CrmProviderSchema = z.object({
  databaseUrl: z.string().min(10),
  provider: z.enum(CRM_PROVIDER_IDS),
})

setupRouter.post('/crm-provider', async (req, res) => {
  const parsed = CrmProviderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.issues[0]?.message ?? 'Invalid input', meta: {} })
    return
  }
  const { availableCrmProviderIds } = await import('../services/crm/index.js')
  const to = parsed.data.provider
  if (!availableCrmProviderIds().includes(to)) {
    res.status(400).json({ data: null, error: 'errors.crm.provider_not_available', meta: {} })
    return
  }

  let client: ReturnType<typeof postgres> | null = null
  try {
    client = postgres(parsed.data.databaseUrl, { max: 1, onnotice: () => {} })
    const [row] = await client`SELECT value FROM system_settings WHERE key = 'crm_provider' LIMIT 1`
    const current = normalizeCrmProviderSetting(row?.['value'])
    const [linked] = await client`
      SELECT (SELECT count(*) FROM activities
                WHERE crm_what_id IS NOT NULL OR crm_who_id IS NOT NULL
                   OR crm_related_id IS NOT NULL OR crm_record_id IS NOT NULL)
           + (SELECT count(*) FROM activity_crm_tickets)
           + (SELECT count(*) FROM crm_historical_events) AS n
    `
    const hasLinked = Number(linked?.['n'] ?? 0) > 0
    if (!crmProviderChangeAllowed(current, to, hasLinked)) {
      res.status(409).json({ data: null, error: 'errors.crm.provider_locked', meta: {} })
      return
    }
    const value = { provider: to, dataProvider: to !== 'none' && !hasLinked ? to : current.dataProvider }
    await client`
      INSERT INTO system_settings (key, value) VALUES ('crm_provider', ${client.json(value)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `
    res.json({ data: value, error: null, meta: {} })
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : 'Failed to save the CRM choice', meta: {} })
  } finally {
    if (client) await client.end({ timeout: 2 }).catch(() => {})
  }
})

// POST /api/setup/test-okta
// Validates an Okta domain by fetching its OIDC discovery document.
setupRouter.post('/test-okta', async (req, res) => {
  const parsed = z.object({ domain: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.validation.domain_required', meta: {} })
    return
  }
  const host = /^https?:\/\//.test(parsed.data.domain)
    ? parsed.data.domain.replace(/\/$/, '')
    : `https://${parsed.data.domain}`
  try {
    const r = await safeFetch(`${host}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) })
    const text = await r.text()
    if (!r.ok) {
      res.status(400).json({ data: { ok: false }, error: `Okta returned ${r.status}`, meta: {} })
      return
    }
    const json = JSON.parse(text) as { issuer?: string }
    res.json({ data: { ok: true, issuer: json.issuer ?? null }, error: null, meta: {} })
  } catch (err) {
    res.status(400).json({ data: { ok: false }, error: err instanceof Error ? err.message : 'Connection failed', meta: {} })
  }
})

// POST /api/setup/test-salesforce
// Validates that the Salesforce login URL is reachable (expects a 400 from the token endpoint — any HTTP response means it's up).
setupRouter.post('/test-salesforce', async (req, res) => {
  const parsed = z.object({ loginUrl: z.string().optional() }).safeParse(req.body)
  const loginUrl = (parsed.success ? parsed.data.loginUrl : null) ?? 'https://login.salesforce.com'
  try {
    // v1.477.0: the same salesforce.com / force.com host rule the saved
    // config uses, not only "any public https host".
    await assertSalesforceLoginUrl(loginUrl)
    const r = await safeFetch(`${loginUrl.replace(/\/$/, '')}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000),
    })
    // Any HTTP response (even 400 "invalid_client") means the endpoint is reachable.
    res.json({ data: { ok: true, status: r.status }, error: null, meta: {} })
  } catch (err) {
    res.status(400).json({ data: { ok: false }, error: err instanceof Error ? err.message : 'Connection failed', meta: {} })
  }
})

// The AI provider chosen on step 8 (AI Assistant, CLAUDE.md §14). Setup has
// no database connection of its own, so the test calls the provider straight
// from the form and nothing is recorded.
// No webhook here: these routes answer before anyone has signed in.
const SetupAiProviderSchema = z.object({
  kind: z.enum(AI_SETUP_PROVIDER_KINDS),
  model: z.string().trim().min(1).max(200),
  secret: z.string().trim().min(1).max(8000),
  endpoint: z.string().trim().max(500).optional(),
  apiVersion: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  accessKeyId: z.string().trim().max(200).optional(),
  resource: z.string().trim().max(100).optional(),
  organization: z.string().trim().max(200).optional(),
})
type SetupAiProvider = z.infer<typeof SetupAiProviderSchema>

function setupProviderField(p: SetupAiProvider, field: AiProviderField): string | null {
  const info = AI_PROVIDER_KIND_INFO[p.kind]
  if (!info.required.includes(field) && !info.optional.includes(field)) return null
  const v = field === 'allowedCustomHost' ? undefined : p[field]
  return v && v.length > 0 ? v : null
}

function missingSetupField(p: SetupAiProvider): AiProviderField | null {
  for (const field of AI_PROVIDER_KIND_INFO[p.kind].required) {
    if (!setupProviderField(p, field)) return field
  }
  return null
}

// POST /api/setup/test-ai-provider
setupRouter.post('/test-ai-provider', async (req, res) => {
  const parsed = SetupAiProviderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.validation.ai_config_required', meta: {} })
    return
  }
  const p = parsed.data
  const missing = missingSetupField(p)
  if (missing) {
    res.status(400).json({ data: null, error: `errors.ai.missing_${missing}`, meta: {} })
    return
  }
  const { callProvider } = await import('../services/ai/adapters.js')
  const outcome = await callProvider({
    id: 'setup',
    kind: p.kind,
    name: 'Setup',
    model: p.model,
    secret: p.secret,
    endpoint: setupProviderField(p, 'endpoint'),
    apiVersion: setupProviderField(p, 'apiVersion'),
    allowedCustomHost: null,
    region: setupProviderField(p, 'region'),
    accessKeyId: setupProviderField(p, 'accessKeyId'),
    resource: setupProviderField(p, 'resource'),
    organization: setupProviderField(p, 'organization'),
    allowPrivateNetwork: false,
    price: null,
  }, { user: 'Reply with the word OK.', maxTokens: 2000, effort: 'low' })
  if (outcome.status === 'ok') {
    res.json({ data: { ok: true }, error: null, meta: {} })
    return
  }
  res.status(400).json({ data: { ok: false }, error: outcome.message, meta: {} })
})

// POST /api/setup/ai-provider
// Saves the step-8 provider as the active default and turns the AI assistant
// on. The key is encrypted with the TOKEN_ENCRYPTION_KEY from step 3, the one
// the server will run with once the env block is saved.
setupRouter.post('/ai-provider', async (req, res) => {
  const parsed = SetupAiProviderSchema.extend({
    databaseUrl: z.string().min(10),
    tokenKey: z.string().regex(/^[a-f0-9]{64}$/i),
  }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.validation.ai_config_required', meta: {} })
    return
  }
  const p = parsed.data
  const missing = missingSetupField(p)
  if (missing) {
    res.status(400).json({ data: null, error: `errors.ai.missing_${missing}`, meta: {} })
    return
  }
  const { assertProviderHost } = await import('../services/ai/adapters.js')
  try {
    await assertProviderHost({
      kind: p.kind,
      endpoint: setupProviderField(p, 'endpoint'),
      allowedCustomHost: null,
      region: setupProviderField(p, 'region'),
      resource: setupProviderField(p, 'resource'),
      allowPrivateNetwork: false,
    })
  } catch (err) {
    res.status(400).json({ data: null, error: err instanceof Error ? err.message : String(err), meta: {} })
    return
  }
  const { encryptTokenWithKey } = await import('../services/config/crypto.js')
  const secretEncrypted = encryptTokenWithKey(p.secret, p.tokenKey)
  const name = AI_PROVIDER_DEFAULT_NAMES[p.kind]

  let client: ReturnType<typeof postgres> | null = null
  try {
    client = postgres(p.databaseUrl, { max: 1, onnotice: () => {} })
    await client.begin(async (tx) => {
      await tx`UPDATE ai_providers SET is_default = false WHERE is_default`
      await tx`
        INSERT INTO ai_providers (kind, name, is_active, is_default, model, secret_encrypted,
          endpoint, api_version, region, access_key_id, resource, organization)
        VALUES (${p.kind}, ${name}, true, true, ${p.model}, ${secretEncrypted},
          ${setupProviderField(p, 'endpoint')}, ${setupProviderField(p, 'apiVersion')},
          ${setupProviderField(p, 'region')}, ${setupProviderField(p, 'accessKeyId')},
          ${setupProviderField(p, 'resource')}, ${setupProviderField(p, 'organization')})
      `
      const settings = { enabled: true, monthlyBudgetUsd: null, budgetAlertSentFor: null }
      await tx`
        INSERT INTO system_settings (key, value) VALUES ('ai_settings', ${tx.json(settings)})
        ON CONFLICT (key) DO UPDATE SET value = jsonb_set(system_settings.value, '{enabled}', 'true'::jsonb), updated_at = now()
      `
    })
    res.json({ data: { ok: true }, error: null, meta: {} })
  } catch (err) {
    res.status(500).json({ data: null, error: err instanceof Error ? err.message : 'Failed to save the AI provider', meta: {} })
  } finally {
    if (client) await client.end({ timeout: 2 }).catch(() => {})
  }
})

// Helpful no-op used by client; ensures sql import isn't tree-shaken in unusual builds
void sql
