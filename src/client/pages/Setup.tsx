import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2, AlertCircle, Copy, RefreshCw, Database, Key, Globe,
  ArrowRight, ShieldCheck, Sparkles, UserPlus, LogIn, Cloud, CalendarDays, Loader2, Check, X, Ban,
} from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { Spinner } from '../components/ui/spinner.js'
import { Badge } from '../components/ui/badge.js'
import { AuthShell } from '../components/auth/AuthShell.js'
import { PASSWORD_RULES, validatePasswordComplexity } from '../../shared/schemas/password.js'
import { AI_SETUP_PROVIDER_KINDS } from '../../shared/ai.js'
import { cn } from '../lib/utils.js'
import { AiProviderFields, aiProviderDraftBody, aiProviderDraftComplete, emptyAiProviderDraft, type AiProviderDraft } from '../components/admin/ai/AiProviderFields.js'

type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

interface DbTestResult {
  ok: boolean
  latencyMs?: number
  version?: string
  database?: string
  schemaInstalled?: boolean
  // v1.247.0: schemaInstalled alone only proves the tables exist, not that
  // seeding ever ran — see the Step 1 Next-button gate below.
  hasTeam?: boolean
}

interface MigrateResult {
  ok: boolean
  log: string[]
}

interface TestResult {
  ok: boolean
  message?: string
}

export default function Setup() {
  const { t } = useTranslation()
  // Step 0 (v1.425.0, security audit L9): the one-time setup token from the
  // server log. Every other setup call sends it in X-Setup-Token. Held in
  // state only, never stored.
  const [step, setStep] = useState<Step>(0)
  const [setupToken, setSetupToken] = useState('')
  const [tokenChecking, setTokenChecking] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)

  // Step 1: Database
  const [dbUrl, setDbUrl] = useState('postgresql://impactiq:impactiq@postgres:5432/impactiq')
  const [dbTesting, setDbTesting] = useState(false)
  const [dbResult, setDbResult] = useState<DbTestResult | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [migrateResult, setMigrateResult] = useState<MigrateResult | null>(null)

  // Step 2: Initial admin
  const [adminEmail, setAdminEmail] = useState('')
  const [adminName, setAdminName] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState('')
  const [adminCreating, setAdminCreating] = useState(false)
  const [adminCreated, setAdminCreated] = useState(false)
  const [adminError, setAdminError] = useState<string | null>(null)

  // Step 3: Security keys
  const [tokenKey, setTokenKey] = useState('')
  const [keyGenerating, setKeyGenerating] = useState(false)
  // v1.247.0: SESSION_SECRET was previously never generated here at all —
  // env.ts's requireSecret() falls back to reusing TOKEN_ENCRYPTION_KEY's
  // value with a "deprecated" warning if SESSION_SECRET is unset, so
  // nothing broke, but a fresh install had no reason to share one secret
  // across two unrelated purposes (HMAC-signing session cookies vs.
  // AES-encrypting stored SF/MS tokens). Generated the same way, as its own
  // independent field.
  const [sessionSecret, setSessionSecret] = useState('')
  const [sessionKeyGenerating, setSessionKeyGenerating] = useState(false)

  // Step 4: App URL
  const [appUrl, setAppUrl] = useState('')

  // Step 5: Okta
  const [oktaDomain, setOktaDomain] = useState('')
  const [oktaClientId, setOktaClientId] = useState('')
  const [oktaClientSecret, setOktaClientSecret] = useState('')
  const [oktaTesting, setOktaTesting] = useState(false)
  const [oktaResult, setOktaResult] = useState<TestResult | null>(null)

  // Step 6: CRM (Salesforce, HubSpot, or none). Salesforce takes its Connected
  // App details here; HubSpot is connected after setup in Admin → Integrations.
  const [crmChoice, setCrmChoice] = useState<'salesforce' | 'hubspot' | 'none'>('salesforce')
  const [crmSaving, setCrmSaving] = useState(false)
  const [crmError, setCrmError] = useState<string | null>(null)
  const [sfClientId, setSfClientId] = useState('')
  const [sfClientSecret, setSfClientSecret] = useState('')
  const [sfLoginUrl, setSfLoginUrl] = useState('https://login.salesforce.com')
  const [sfTesting, setSfTesting] = useState(false)
  const [sfResult, setSfResult] = useState<TestResult | null>(null)

  // Step 7: Microsoft Graph
  const [msClientId, setMsClientId] = useState('')
  const [msClientSecret, setMsClientSecret] = useState('')
  const [msTenantId, setMsTenantId] = useState('')
  const [msValidated, setMsValidated] = useState(false)

  // Step 8: AI provider (AI Assistant)
  const [aiDraft, setAiDraft] = useState<AiProviderDraft>(() => emptyAiProviderDraft())
  const [aiTesting, setAiTesting] = useState(false)
  const [aiSaving, setAiSaving] = useState(false)
  const [aiResult, setAiResult] = useState<TestResult | null>(null)
  const [aiSaved, setAiSaved] = useState(false)

  // Step 9: Summary
  const [copied, setCopied] = useState<string | null>(null)
  const [markedComplete, setMarkedComplete] = useState(false)

  useEffect(() => {
    if (!appUrl) setAppUrl(window.location.origin)
  }, [])

  function setupFetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), 'X-Setup-Token': setupToken.trim() },
    })
  }

  async function verifySetupToken() {
    setTokenChecking(true)
    setTokenError(null)
    try {
      const res = await setupFetch('/api/setup/verify-token', { method: 'POST' })
      const json = await res.json() as { error: string | null }
      if (json.error) setTokenError(json.error)
      else setStep(1)
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Network error')
    }
    setTokenChecking(false)
  }

  async function testDatabase() {
    setDbTesting(true)
    setDbResult(null)
    setDbError(null)
    setMigrateResult(null)
    try {
      const res = await setupFetch('/api/setup/test-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ databaseUrl: dbUrl }),
      })
      const json = await res.json() as { data: DbTestResult; error: string | null }
      if (json.error) {
        setDbError(json.error)
      } else {
        setDbResult(json.data)
      }
    } catch (err) {
      setDbError(err instanceof Error ? err.message : 'Network error')
    }
    setDbTesting(false)
  }

  async function runMigrations() {
    setMigrating(true)
    setMigrateResult(null)
    try {
      const res = await setupFetch('/api/setup/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ databaseUrl: dbUrl }),
      })
      const json = await res.json() as { data: MigrateResult; error: string | null }
      setMigrateResult(json.data)
      if (!json.error) await testDatabase()
    } catch (err) {
      setMigrateResult({ ok: false, log: [err instanceof Error ? err.message : 'Network error'] })
    }
    setMigrating(false)
  }

  async function createAdmin() {
    setAdminCreating(true)
    setAdminError(null)
    try {
      const res = await setupFetch('/api/setup/create-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ databaseUrl: dbUrl, email: adminEmail, displayName: adminName, password: adminPassword }),
      })
      const json = await res.json() as { data: { ok?: boolean } | null; error: string | null }
      if (json.error) {
        setAdminError(json.error)
      } else if (json.data?.ok) {
        setAdminCreated(true)
      }
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Network error')
    }
    setAdminCreating(false)
  }

  async function generateKey() {
    setKeyGenerating(true)
    try {
      const res = await setupFetch('/api/setup/generate-key', { credentials: 'same-origin' })
      const json = await res.json() as { data: { key: string }; error: string | null }
      if (json.data?.key) setTokenKey(json.data.key)
    } catch { /* ignore */ }
    setKeyGenerating(false)
  }

  async function generateSessionSecret() {
    setSessionKeyGenerating(true)
    try {
      // Same generic random-hex endpoint TOKEN_ENCRYPTION_KEY uses — it
      // holds no server-side state per call, so calling it again here for
      // an unrelated secret is exactly the intended reuse, not a copy-paste
      // of TOKEN_ENCRYPTION_KEY's own value.
      const res = await setupFetch('/api/setup/generate-key', { credentials: 'same-origin' })
      const json = await res.json() as { data: { key: string }; error: string | null }
      if (json.data?.key) setSessionSecret(json.data.key)
    } catch { /* ignore */ }
    setSessionKeyGenerating(false)
  }

  async function testOkta() {
    setOktaTesting(true)
    setOktaResult(null)
    try {
      const res = await setupFetch('/api/setup/test-okta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ domain: oktaDomain }),
      })
      const json = await res.json() as { data: { ok: boolean; issuer?: string }; error: string | null }
      if (json.error || !json.data?.ok) {
        setOktaResult({ ok: false, message: json.error ?? 'Connection failed' })
      } else {
        setOktaResult({ ok: true, message: json.data.issuer ?? 'Connected' })
      }
    } catch (err) {
      setOktaResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' })
    }
    setOktaTesting(false)
  }

  async function testSalesforce() {
    setSfTesting(true)
    setSfResult(null)
    try {
      const res = await setupFetch('/api/setup/test-salesforce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ loginUrl: sfLoginUrl || 'https://login.salesforce.com' }),
      })
      const json = await res.json() as { data: { ok: boolean }; error: string | null }
      if (json.error || !json.data?.ok) {
        setSfResult({ ok: false, message: json.error ?? 'Unreachable' })
      } else {
        setSfResult({ ok: true, message: t('setup.step6.connected') })
      }
    } catch (err) {
      setSfResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' })
    }
    setSfTesting(false)
  }

  // Saves the CRM choice to the new database (system_settings.crm_provider),
  // then moves on. Saved on Skip too, so "Skip" never leaves the choice
  // unrecorded.
  async function saveCrmAndContinue() {
    setCrmSaving(true)
    setCrmError(null)
    try {
      const res = await setupFetch('/api/setup/crm-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ databaseUrl: dbUrl, provider: crmChoice }),
      })
      const json = await res.json() as { data: unknown; error: string | null }
      if (json.error) { setCrmError(json.error); return }
      setStep(7)
    } catch (err) {
      setCrmError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setCrmSaving(false)
    }
  }

  function validateMicrosoft() {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    setMsValidated(
      msClientId.trim().length > 0 &&
      msClientSecret.trim().length > 0 &&
      uuidRe.test(msTenantId.trim()),
    )
  }

  async function testAiProvider() {
    setAiTesting(true)
    setAiResult(null)
    try {
      const res = await setupFetch('/api/setup/test-ai-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(aiProviderDraftBody(aiDraft)),
      })
      const json = await res.json() as { data: { ok: boolean } | null; error: string | null }
      if (json.error || !json.data?.ok) {
        setAiResult({ ok: false, message: json.error ?? 'Connection failed' })
      } else {
        setAiResult({ ok: true, message: 'setup.step8.connected' })
      }
    } catch (err) {
      setAiResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setAiTesting(false)
    }
  }

  // Saves the provider to the new database as the active default, then moves on.
  async function saveAiAndContinue() {
    setAiSaving(true)
    setAiResult(null)
    try {
      const res = await setupFetch('/api/setup/ai-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ...aiProviderDraftBody(aiDraft), databaseUrl: dbUrl, tokenKey }),
      })
      const json = await res.json() as { data: unknown; error: string | null }
      if (json.error) { setAiResult({ ok: false, message: json.error }); return }
      setAiSaved(true)
      setStep(9)
    } catch (err) {
      setAiResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setAiSaving(false)
    }
  }


  async function copy(text: string, label: string) {
    let ok = false
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch { ok = false }
    if (!ok) {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.setAttribute('readonly', '')
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy'); ok = true } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
    if (ok) {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    }
  }

  // v1.247.0: was `schemaInstalled === true` alone — that's table
  // existence, not "seeding actually ran." A prior attempt that committed
  // migrations but failed (or was skipped) partway through seeding left
  // Next enabled with an empty `teams` table, which is exactly what
  // create-admin needs and 400s on (errors.setup.team_not_found).
  const dbReady = !!dbResult?.ok && dbResult.schemaInstalled === true && dbResult.hasTeam === true
  const adminReady = adminCreated
  const adminInputValid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) &&
    adminName.trim().length > 0 &&
    validatePasswordComplexity(adminPassword).ok &&
    adminPassword === adminPasswordConfirm
  const keyReady = /^[a-f0-9]{64}$/i.test(tokenKey)
  const sessionKeyReady = /^[a-f0-9]{64}$/i.test(sessionSecret)
  const appUrlReady = /^https?:\/\//.test(appUrl)

  const normalizedAppUrl = appUrl.replace(/\/$/, '')
  const oktaRedirectUri = `${normalizedAppUrl}/auth/callback`
  const sfRedirectUri = `${normalizedAppUrl}/auth/salesforce/callback`

  function buildEnvBlock(): string {
    const lines: string[] = [
      `DATABASE_URL=${dbUrl}`,
      `SESSION_SECRET=${sessionSecret}`,
      `TOKEN_ENCRYPTION_KEY=${tokenKey}`,
      `APP_URL=${normalizedAppUrl}`,
      `NODE_ENV=production`,
      `PORT=3000`,
    ]
    if (oktaDomain && oktaClientId && oktaClientSecret) {
      const host = /^https?:\/\//.test(oktaDomain) ? oktaDomain.replace(/\/$/, '') : `https://${oktaDomain}`
      lines.push('', '# Okta SSO')
      lines.push(`OKTA_DOMAIN=${host}`)
      lines.push(`OKTA_CLIENT_ID=${oktaClientId}`)
      lines.push(`OKTA_CLIENT_SECRET=${oktaClientSecret}`)
      lines.push(`OKTA_REDIRECT_URI=${oktaRedirectUri}`)
    }
    if (crmChoice === 'salesforce' && sfClientId && sfClientSecret) {
      lines.push('', '# Salesforce')
      lines.push(`SF_CLIENT_ID=${sfClientId}`)
      lines.push(`SF_CLIENT_SECRET=${sfClientSecret}`)
      lines.push(`SF_REDIRECT_URI=${sfRedirectUri}`)
      if (sfLoginUrl && sfLoginUrl !== 'https://login.salesforce.com') {
        lines.push(`SF_LOGIN_URL=${sfLoginUrl}`)
      }
    }
    if (msClientId && msClientSecret && msTenantId) {
      lines.push('', '# Microsoft Graph (Outlook)')
      lines.push(`MS_CLIENT_ID=${msClientId}`)
      lines.push(`MS_CLIENT_SECRET=${msClientSecret}`)
      lines.push(`MS_TENANT_ID=${msTenantId}`)
    }
    return lines.join('\n')
  }

  const TOTAL_STEPS = 9

  return (
    <AuthShell scrollable>
      <div className="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <div className="rounded-lg bg-blue-600 p-2 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            {/* v1.352.0: this header sits directly on AuthShell's permanently-dark
                backdrop (not inside the white card below), so — like AuthShell's
                own chrome — it uses fixed white/light styling rather than
                `dark:`-conditional classes, which would go near-invisible here. */}
            <h1 className="text-xl font-semibold text-white">{t('setup.title')}</h1>
            <p className="text-sm text-white/70">{t('setup.subtitle')}</p>
          </div>
        </div>

        {/* Stepper — same "fixed light styling, not dark:-conditional" reasoning
            as the header above. */}
        <div className="mb-6 flex items-center gap-1">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n, i) => (
            <div key={n} className="flex flex-1 items-center gap-1">
              <div
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                  step >= n
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/20 text-white/70',
                )}
              >
                {step > n ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
              </div>
              {i < TOTAL_STEPS - 1 && (
                <div className={cn('h-0.5 flex-1', step > n ? 'bg-blue-600' : 'bg-white/20')} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">

          {/* ── Step 0: setup token ── */}
          {step === 0 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.token.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.token.description')}</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setupToken">{t('setup.token.label')}</Label>
                <Input
                  id="setupToken"
                  value={setupToken}
                  onChange={(e) => { setSetupToken(e.target.value); setTokenError(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && setupToken.trim()) void verifySetupToken() }}
                  autoComplete="off"
                  className="font-mono text-xs"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.token.hint')}</p>
              </div>
              {tokenError && (
                <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {tokenError.startsWith('errors.') ? t(tokenError) : tokenError}
                </p>
              )}
              <div className="flex justify-end">
                <Button onClick={() => { void verifySetupToken() }} disabled={!setupToken.trim() || tokenChecking}>
                  {tokenChecking ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <ArrowRight className="mr-1 h-3.5 w-3.5" />}
                  {t('setup.next')}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 1: Database ── */}
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step1.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step1.description')}</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dbUrl">{t('setup.step1.url_label')}</Label>
                <Input
                  id="dbUrl"
                  value={dbUrl}
                  onChange={(e) => { setDbUrl(e.target.value); setDbResult(null); setMigrateResult(null) }}
                  placeholder="postgresql://user:password@host:5432/dbname"
                  className="font-mono text-xs"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.step1.hint')}</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={testDatabase} disabled={dbTesting || !dbUrl} variant="secondary" size="sm">
                  {dbTesting ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                  {t('setup.step1.test')}
                </Button>
                {dbResult?.ok && (!dbResult.schemaInstalled || !dbResult.hasTeam) && (
                  <Button onClick={runMigrations} disabled={migrating} size="sm">
                    {migrating ? <Spinner className="mr-1 h-3 w-3" /> : null}
                    {t('setup.step1.migrate')}
                  </Button>
                )}
              </div>
              {dbError && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="font-mono text-xs">{t(dbError, dbError)}</span>
                </div>
              )}
              {dbResult?.ok && (
                <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="flex flex-col gap-0.5 text-xs">
                    <span><strong>{t('setup.step1.connected')}</strong> — Postgres {dbResult.version} · {dbResult.latencyMs}ms · db: {dbResult.database}</span>
                    {!dbResult.schemaInstalled && <span className="text-amber-700 dark:text-amber-400">⚠ {t('setup.step1.schema_missing')}</span>}
                    {dbResult.schemaInstalled && !dbResult.hasTeam && <span className="text-amber-700 dark:text-amber-400">⚠ {t('setup.step1.schema_no_team')}</span>}
                    {dbResult.schemaInstalled && dbResult.hasTeam && <span>✓ {t('setup.step1.schema_installed')}</span>}
                  </div>
                </div>
              )}
              {migrateResult && (
                <pre className={cn('max-h-40 overflow-y-auto rounded-md border px-3 py-2 text-xs font-mono whitespace-pre-wrap', migrateResult.ok ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300' : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300')}>
                  {migrateResult.log.join('\n')}
                </pre>
              )}
              <div className="mt-2 flex justify-end">
                <Button onClick={() => setStep(2)} disabled={!dbReady}>
                  {t('setup.next')} <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 2: Admin account ── */}
          {step === 2 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step2.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step2.description')}</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="adminEmail">{t('setup.step2.email_label')}</Label>
                <Input id="adminEmail" type="email" value={adminEmail} onChange={(e) => { setAdminEmail(e.target.value.trim()); setAdminCreated(false); setAdminError(null) }} placeholder="you@example.com" disabled={adminCreated} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="adminName">{t('setup.step2.name_label')}</Label>
                <Input id="adminName" value={adminName} onChange={(e) => { setAdminName(e.target.value); setAdminCreated(false); setAdminError(null) }} placeholder="Jane Doe" disabled={adminCreated} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="adminPassword">{t('setup.step2.password_label')}</Label>
                <Input id="adminPassword" type="password" autoComplete="new-password" value={adminPassword} onChange={(e) => { setAdminPassword(e.target.value); setAdminCreated(false); setAdminError(null) }} placeholder={t('setup.step2.password_placeholder')} disabled={adminCreated} />
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.step2.password_hint')}</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                  {PASSWORD_RULES.map((r) => {
                    const passed = r.test(adminPassword)
                    return (
                      <li key={r.key} className={passed ? 'text-green-600 dark:text-green-400' : ''}>
                        {passed ? <Check className="mr-1 inline h-3 w-3" /> : <X className="mr-1 inline h-3 w-3" />}
                        {r.label}
                      </li>
                    )
                  })}
                </ul>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="adminPasswordConfirm">{t('setup.step2.password_confirm_label')}</Label>
                <Input id="adminPasswordConfirm" type="password" autoComplete="new-password" value={adminPasswordConfirm} onChange={(e) => { setAdminPasswordConfirm(e.target.value); setAdminError(null) }} disabled={adminCreated} />
                {adminPasswordConfirm.length > 0 && adminPassword !== adminPasswordConfirm && (
                  <p className="text-xs text-red-600 dark:text-red-400">{t('setup.step2.password_mismatch')}</p>
                )}
              </div>
              <Button onClick={createAdmin} disabled={adminCreating || !adminInputValid || adminCreated} size="sm">
                {adminCreating ? <Spinner className="mr-1 h-3 w-3" /> : null}
                {t('setup.step2.create')}
              </Button>
              {adminError && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="font-mono text-xs">{t(adminError, adminError)}</span>
                </div>
              )}
              {adminCreated && (
                <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="text-xs">{t('setup.step2.created', { email: adminEmail })}</span>
                </div>
              )}
              <div className="mt-2 flex justify-between">
                <Button onClick={() => setStep(1)} variant="ghost" size="sm">{t('setup.back')}</Button>
                <Button onClick={() => setStep(3)} disabled={!adminReady}>
                  {t('setup.next')} <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 3: Security keys ── */}
          {step === 3 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Key className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step3.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step3.description')}</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sessionSecret">{t('setup.step3.session_key_label')}</Label>
                <div className="flex gap-2">
                  <Input id="sessionSecret" value={sessionSecret} onChange={(e) => setSessionSecret(e.target.value.trim())} placeholder="64-character hex string" className="font-mono text-xs" />
                  <Button onClick={generateSessionSecret} disabled={sessionKeyGenerating} variant="secondary" size="sm">
                    {sessionKeyGenerating ? <Spinner className="mr-1 h-3 w-3" /> : null}
                    {t('setup.step3.generate')}
                  </Button>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.step3.session_key_hint')}</p>
                {sessionSecret && !sessionKeyReady && <p className="text-xs text-red-600 dark:text-red-400">{t('setup.step3.invalid')}</p>}
                {sessionKeyReady && <p className="text-xs text-green-600 dark:text-green-400">✓ {t('setup.step3.valid')}</p>}
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <strong>{t('setup.step3.warning_title')}</strong>: {t('setup.step3.warning')}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tokenKey">{t('setup.step3.key_label')}</Label>
                <div className="flex gap-2">
                  <Input id="tokenKey" value={tokenKey} onChange={(e) => setTokenKey(e.target.value.trim())} placeholder="64-character hex string" className="font-mono text-xs" />
                  <Button onClick={generateKey} disabled={keyGenerating} variant="secondary" size="sm">
                    {keyGenerating ? <Spinner className="mr-1 h-3 w-3" /> : null}
                    {t('setup.step3.generate')}
                  </Button>
                </div>
                {tokenKey && !keyReady && <p className="text-xs text-red-600 dark:text-red-400">{t('setup.step3.invalid')}</p>}
                {keyReady && <p className="text-xs text-green-600 dark:text-green-400">✓ {t('setup.step3.valid')}</p>}
              </div>
              <div className="mt-2 flex justify-between">
                <Button onClick={() => setStep(2)} variant="ghost" size="sm">{t('setup.back')}</Button>
                <Button onClick={() => setStep(4)} disabled={!keyReady || !sessionKeyReady}>
                  {t('setup.next')} <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 4: App URL ── */}
          {step === 4 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Globe className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step4.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step4.description')}</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appUrl">{t('setup.step4.url_label')}</Label>
                <Input id="appUrl" value={appUrl} onChange={(e) => setAppUrl(e.target.value.trim())} placeholder="https://impactiq.internal.example.com" className="font-mono text-xs" />
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.step4.hint')}</p>
              </div>
              <div className="mt-2 flex justify-between">
                <Button onClick={() => setStep(3)} variant="ghost" size="sm">{t('setup.back')}</Button>
                <Button onClick={() => setStep(5)} disabled={!appUrlReady}>
                  {t('setup.next')} <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 5: Okta ── */}
          {step === 5 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <LogIn className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step5.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step5.description')}</p>
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                {t('setup.step5.setup_hint')}
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>{t('setup.step5.domain_label')}</Label>
                  <Input value={oktaDomain} onChange={(e) => { setOktaDomain(e.target.value.trim()); setOktaResult(null) }} placeholder="https://your-org.okta.com" className="font-mono text-xs" />
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.step5.domain_hint')}</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t('setup.step5.client_id_label')}</Label>
                  <Input value={oktaClientId} onChange={(e) => setOktaClientId(e.target.value.trim())} className="font-mono text-xs" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t('setup.step5.client_secret_label')}</Label>
                  <Input type="password" value={oktaClientSecret} onChange={(e) => setOktaClientSecret(e.target.value)} className="font-mono text-xs" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t('setup.step5.redirect_uri_label')}</Label>
                  <Input value={oktaRedirectUri} readOnly className="font-mono text-xs bg-gray-50 dark:bg-gray-800" />
                </div>
              </div>
              {oktaResult && (
                <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', oktaResult.ok ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300')}>
                  {oktaResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span>{t(oktaResult.message ?? '', oktaResult.message ?? '')}</span>
                </div>
              )}
              <p className="text-xs text-gray-400 dark:text-gray-500 italic">{t('setup.step5.optional_note')}</p>
              <div className="mt-2 flex justify-between">
                <Button onClick={() => setStep(4)} variant="ghost" size="sm">{t('setup.back')}</Button>
                <div className="flex gap-2">
                  <Button onClick={testOkta} disabled={oktaTesting || !oktaDomain} variant="secondary" size="sm">
                    {oktaTesting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    {t('setup.step5.test')}
                  </Button>
                  <Button onClick={() => setStep(6)} variant="ghost" size="sm">{t('setup.step5.skip')}</Button>
                  <Button onClick={() => setStep(6)} disabled={!oktaDomain || !oktaClientId || !oktaClientSecret}>
                    {t('setup.next')} <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 6: CRM ── */}
          {step === 6 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Cloud className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step6.crm_title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step6.crm_description')}</p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('setup.step6.crm_title')}>
                <Button type="button" size="sm" role="radio" aria-checked={crmChoice === 'salesforce'} variant={crmChoice === 'salesforce' ? 'default' : 'outline'} onClick={() => { setCrmChoice('salesforce'); setCrmError(null) }}>
                  <Cloud className="mr-1 h-3.5 w-3.5" />
                  {t('admin.integrations.crm_provider.option_salesforce')}
                </Button>
                <Button type="button" size="sm" role="radio" aria-checked={crmChoice === 'hubspot'} variant={crmChoice === 'hubspot' ? 'default' : 'outline'} onClick={() => { setCrmChoice('hubspot'); setCrmError(null) }}>
                  <Database className="mr-1 h-3.5 w-3.5" />
                  {t('admin.integrations.crm_provider.option_hubspot')}
                </Button>
                <Button type="button" size="sm" role="radio" aria-checked={crmChoice === 'none'} variant={crmChoice === 'none' ? 'default' : 'outline'} onClick={() => { setCrmChoice('none'); setCrmError(null) }}>
                  <Ban className="mr-1 h-3.5 w-3.5" />
                  {t('admin.integrations.crm_provider.option_none')}
                </Button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.step6.crm_change_later')}</p>
              {crmChoice === 'hubspot' && (
                <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {t('setup.step6.hubspot_after_setup')}
                </div>
              )}
              {crmChoice === 'none' && (
                <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {t('admin.integrations.crm_provider.none_body')}
                </div>
              )}
              {crmChoice === 'salesforce' && (
                <>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step6.description')}</p>
                  <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                    {t('setup.step6.setup_hint')}
                  </div>
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('setup.step6.client_id_label')}</Label>
                      <Input value={sfClientId} onChange={(e) => setSfClientId(e.target.value.trim())} className="font-mono text-xs" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('setup.step6.client_secret_label')}</Label>
                      <Input type="password" value={sfClientSecret} onChange={(e) => setSfClientSecret(e.target.value)} className="font-mono text-xs" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('setup.step6.login_url_label')}</Label>
                      <Input value={sfLoginUrl} onChange={(e) => { setSfLoginUrl(e.target.value.trim()); setSfResult(null) }} className="font-mono text-xs" />
                      <p className="text-xs text-gray-400 dark:text-gray-500">{t('setup.step6.login_url_hint')}</p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('setup.step6.redirect_uri_label')}</Label>
                      <Input value={sfRedirectUri} readOnly className="font-mono text-xs bg-gray-50 dark:bg-gray-800" />
                    </div>
                  </div>
                  {sfResult && (
                    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', sfResult.ok ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300')}>
                      {sfResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                      <span>{t(sfResult.message ?? '', sfResult.message ?? '')}</span>
                    </div>
                  )}
                  <p className="text-xs text-gray-400 dark:text-gray-500 italic">{t('setup.step6.optional_note')}</p>
                </>
              )}
              {crmError && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t(crmError, crmError)}</span>
                </div>
              )}
              <div className="mt-2 flex justify-between">
                <Button onClick={() => setStep(5)} variant="ghost" size="sm">{t('setup.back')}</Button>
                <div className="flex gap-2">
                  {crmChoice === 'salesforce' && (
                    <>
                      <Button onClick={testSalesforce} disabled={sfTesting} variant="secondary" size="sm">
                        {sfTesting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                        {t('setup.step6.test')}
                      </Button>
                      <Button onClick={() => { void saveCrmAndContinue() }} disabled={crmSaving} variant="ghost" size="sm">{t('setup.step6.skip')}</Button>
                    </>
                  )}
                  <Button onClick={() => { void saveCrmAndContinue() }} disabled={crmSaving || (crmChoice === 'salesforce' && (!sfClientId || !sfClientSecret))}>
                    {crmSaving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    {t('setup.next')} <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 7: Microsoft Graph ── */}
          {step === 7 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-blue-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step7.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step7.description')}</p>
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                {t('setup.step7.setup_hint')}
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>{t('setup.step7.client_id_label')}</Label>
                  <Input value={msClientId} onChange={(e) => { setMsClientId(e.target.value.trim()); setMsValidated(false) }} className="font-mono text-xs" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t('setup.step7.client_secret_label')}</Label>
                  <Input type="password" value={msClientSecret} onChange={(e) => { setMsClientSecret(e.target.value); setMsValidated(false) }} className="font-mono text-xs" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t('setup.step7.tenant_id_label')}</Label>
                  <Input value={msTenantId} onChange={(e) => { setMsTenantId(e.target.value.trim()); setMsValidated(false) }} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="font-mono text-xs" />
                </div>
              </div>
              {msValidated && (
                <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{t('setup.step7.validated')}</span>
                </div>
              )}
              <p className="text-xs text-gray-400 dark:text-gray-500 italic">{t('setup.step7.optional_note')}</p>
              <div className="mt-2 flex justify-between">
                <Button onClick={() => setStep(6)} variant="ghost" size="sm">{t('setup.back')}</Button>
                <div className="flex gap-2">
                  <Button onClick={validateMicrosoft} variant="secondary" size="sm" disabled={!msClientId || !msClientSecret || !msTenantId}>
                    {t('setup.step7.validate')}
                  </Button>
                  <Button onClick={() => setStep(8)} variant="ghost" size="sm">{t('setup.step7.skip')}</Button>
                  <Button onClick={() => setStep(8)} disabled={!msClientId || !msClientSecret || !msTenantId}>
                    {t('setup.next')} <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 8: AI provider ── */}
          {step === 8 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step8.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step8.description')}</p>
              <AiProviderFields
                value={aiDraft}
                onChange={(next) => { setAiDraft(next); setAiResult(null); setAiSaved(false) }}
                hideFields={['allowedCustomHost']}
                kinds={AI_SETUP_PROVIDER_KINDS}
              />
              {aiResult && (
                <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', aiResult.ok ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300')}>
                  {aiResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span>{t(aiResult.message ?? '', aiResult.message ?? '')}</span>
                </div>
              )}
              <p className="text-xs text-gray-400 dark:text-gray-500 italic">{t('setup.step8.optional_note')}</p>
              <div className="mt-2 flex justify-between">
                <Button onClick={() => setStep(7)} variant="ghost" size="sm">{t('setup.back')}</Button>
                <div className="flex gap-2">
                  <Button onClick={testAiProvider} disabled={aiTesting || !aiProviderDraftComplete(aiDraft)} variant="secondary" size="sm">
                    {aiTesting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}
                    {t('setup.step8.test')}
                  </Button>
                  <Button onClick={() => setStep(9)} variant="ghost" size="sm">{t('setup.step8.skip')}</Button>
                  <Button onClick={saveAiAndContinue} disabled={aiSaving || !aiProviderDraftComplete(aiDraft)}>
                    {aiSaving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    {t('setup.step8.save')} <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 9: Summary ── */}
          {step === 9 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('setup.step9.title')}</h2>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('setup.step9.description')}</p>
              {aiSaved && (
                <p className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-300">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t('setup.step9.ai_saved', { provider: t(`ai_assistant.kinds.${aiDraft.kind}`) })}
                </p>
              )}

              <div className="relative rounded-md border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <pre className="overflow-x-auto p-4 text-xs font-mono text-gray-800 dark:text-gray-200 whitespace-pre">
                  {buildEnvBlock()}
                </pre>
                <button
                  onClick={() => copy(buildEnvBlock(), 'env')}
                  className="absolute right-2 top-2 flex items-center gap-1 rounded bg-white px-2 py-1 text-xs text-gray-700 shadow-sm hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  <Copy className="h-3 w-3" />
                  {copied === 'env' ? t('setup.copied') : t('setup.copy')}
                </button>
              </div>

              <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                <p className="mb-2 font-semibold">{t('setup.step9.next_steps')}</p>
                <ol className="ml-4 list-decimal space-y-1 text-xs">
                  <li>{t('setup.step9.step_copy')}</li>
                  <li>{t('setup.step9.step_paste')}</li>
                  <li>{t('setup.step9.step_redeploy')}</li>
                  <li>{t('setup.step9.step_verify')}</li>
                </ol>
              </div>

              <Badge variant="success" className="self-start">{t('setup.step9.ready')}</Badge>

              {!markedComplete && (
                <div className="mt-2 flex justify-between">
                  <Button onClick={() => setStep(8)} variant="ghost" size="sm">{t('setup.back')}</Button>
                  <Button onClick={() => setMarkedComplete(true)}>
                    {t('setup.step9.mark_complete')} <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              )}

              {markedComplete && (
                <div className="mt-2 rounded-md border-2 border-amber-300 bg-amber-50 px-4 py-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="mb-2 flex items-center gap-2">
                    <RefreshCw className="h-5 w-5" />
                    <h3 className="text-sm font-semibold">{t('setup.step9.restart_title')}</h3>
                  </div>
                  <p className="text-xs">{t('setup.step9.restart_body')}</p>
                  <ol className="mt-2 ml-4 list-decimal space-y-1 text-xs">
                    <li>{t('setup.step9.restart_step1')}</li>
                    <li>{t('setup.step9.restart_step2')}</li>
                    <li>{t('setup.step9.restart_step3')}</li>
                  </ol>
                </div>
              )}
            </div>
          )}

        </div>

        <p className="mt-6 text-center text-xs text-white/50">
          ImpactIQ · {t('setup.footer')}
        </p>
      </div>
    </AuthShell>
  )
}
