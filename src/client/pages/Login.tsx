import { useState, useEffect, useRef, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, LogIn, Check, X, Download, ShieldCheck, KeyRound } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { Spinner } from '../components/ui/spinner.js'
import { AuthShell } from '../components/auth/AuthShell.js'
import { PASSWORD_RULES, validatePasswordComplexity } from '../../shared/schemas/password.js'
import { isSsoErrorReason, type SsoErrorReason } from '../../shared/ssoErrors.js'

// A refused Okta or Azure sign-in lands back here as
// `/?oktaConnect=error&reason=<key>` (`ssoConnect` for Azure). Only reasons on
// the shared list are shown; anything else reads as a failed sign-in.
type SsoError = { reason: SsoErrorReason; provider: 'Okta' | 'Microsoft' }
const SSO_ERROR_PARAMS = ['oktaConnect', 'ssoConnect', 'reason'] as const

function readSsoError(): SsoError | null {
  const params = new URLSearchParams(window.location.search)
  const provider = params.get('oktaConnect') === 'error' ? 'Okta' : params.get('ssoConnect') === 'error' ? 'Microsoft' : null
  if (!provider) return null
  const reason = params.get('reason')
  return { reason: isSsoErrorReason(reason) ? reason : 'errors.auth.sso_failed', provider }
}

type Step = 'login' | 'mfa-enroll' | 'mfa-enroll-show-codes' | 'mfa-verify' | 'change-password'

type SsoProvider = 'okta' | 'azure'

// Pre-auth, so there's no user session to key this off of — a plain
// device-local remembered choice, same convention as LanguagePicker's own
// localStorage persistence on this same page.
const SSO_PROVIDER_STORAGE_KEY = 'impactiq_sso_provider'

// v1.346.0: one login button rather than a separate "Sign in with Okta" /
// "Sign in with Microsoft" button stacked on top of each other. With only
// one SSO provider configured (the common case) there's nothing to choose
// — it's already a single button, just generically labeled. With both
// configured, clicking opens a small inline picker instead of showing two
// buttons at once; picking a provider can optionally remember the choice
// on this device (checkbox, on by default) so a later visit skips the
// picker and goes straight through — with a "Switch" link to change it.
function SsoSignIn({ oktaConfigured, azureConfigured }: { oktaConfigured: boolean; azureConfigured: boolean }) {
  const { t } = useTranslation()
  const providers: SsoProvider[] = []
  if (oktaConfigured) providers.push('okta')
  if (azureConfigured) providers.push('azure')

  const [remembered, setRemembered] = useState<SsoProvider | null>(() => {
    try {
      const stored = localStorage.getItem(SSO_PROVIDER_STORAGE_KEY)
      return stored === 'okta' || stored === 'azure' ? stored : null
    } catch { return null }
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [rememberChoice, setRememberChoice] = useState(true)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [pickerOpen])

  if (providers.length === 0) return null

  function go(provider: SsoProvider, persist: boolean) {
    try {
      if (persist) localStorage.setItem(SSO_PROVIDER_STORAGE_KEY, provider)
      else localStorage.removeItem(SSO_PROVIDER_STORAGE_KEY)
    } catch { /* ignore */ }
    window.location.assign(provider === 'okta' ? '/auth/okta' : '/auth/azure')
  }

  function switchProvider() {
    try { localStorage.removeItem(SSO_PROVIDER_STORAGE_KEY) } catch { /* ignore */ }
    setRemembered(null)
  }

  // Only one provider configured — nothing to choose, ever.
  if (providers.length === 1) {
    return (
      <Button type="button" variant="outline" className="mb-4 w-full" onClick={() => go(providers[0]!, false)}>
        <LogIn className="mr-2 h-4 w-4" />
        {t('auth.signInWithIdentityProvider', 'Sign in with Identity Provider')}
      </Button>
    )
  }

  // Both configured, and a remembered choice from a prior visit still
  // applies — one click, straight through, no picker.
  if (remembered && providers.includes(remembered)) {
    return (
      <div className="mb-4 flex items-center gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={() => go(remembered, true)}>
          <LogIn className="mr-2 h-4 w-4" />
          {remembered === 'okta' ? t('auth.signInWithOkta') : t('auth.signInWithAzure', 'Sign in with Microsoft')}
        </Button>
        <button
          type="button"
          onClick={switchProvider}
          className="shrink-0 text-xs text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline dark:text-gray-500 dark:hover:text-gray-300"
        >
          {t('auth.switchSignInMethod', 'Switch')}
        </button>
      </div>
    )
  }

  // Both configured, no remembered choice yet — one button; clicking it
  // opens a small inline picker instead of showing two buttons at once.
  // Rendered in normal document flow (not absolutely positioned) so it
  // pushes the "Or with email" divider and the fields below it down,
  // rather than floating on top of them and obscuring the divider.
  return (
    <div className="mb-4" ref={ref}>
      <Button type="button" variant="outline" className="w-full" onClick={() => setPickerOpen((v) => !v)}>
        <LogIn className="mr-2 h-4 w-4" />
        {t('auth.signInWithIdentityProvider', 'Sign in with Identity Provider')}
      </Button>
      {pickerOpen && (
        <div className="mt-1 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            {t('auth.chooseSignInMethod', 'Choose how to sign in')}
          </p>
          <button
            type="button"
            onClick={() => go('okta', rememberChoice)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <LogIn className="h-4 w-4 shrink-0" />
            {t('auth.continueWithOkta', 'Continue with Okta')}
          </button>
          <button
            type="button"
            onClick={() => go('azure', rememberChoice)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <LogIn className="h-4 w-4 shrink-0" />
            {t('auth.continueWithAzure', 'Continue with Microsoft')}
          </button>
          <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-gray-100 px-2 pt-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            {t('auth.rememberMyChoice', 'Remember my choice on this device')}
          </label>
        </div>
      )}
    </div>
  )
}

export default function Login({ onSuccess, forceChangePassword = false }: { onSuccess: () => void; forceChangePassword?: boolean }) {
  const { t, i18n: i18nHook } = useTranslation()
  // Server errors come back as i18n keys like `errors.invalid_credentials`.
  // Look them up if the current bundle has them, otherwise fall back to
  // English if a translation exists there, and finally to the raw string
  // (which covers ad-hoc client-side strings like "Network error").
  const translateError = (raw: string | null | undefined): string => {
    if (!raw) return ''
    if (i18nHook.exists(raw)) return t(raw)
    if (i18nHook.exists(raw, { lng: 'en' })) return t(raw, { lng: 'en' })
    return raw
  }
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')
  const [step, setStep] = useState<Step>(forceChangePassword ? 'change-password' : 'login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ssoError, setSsoError] = useState<SsoError | null>(readSsoError)
  const [oktaConfigured, setOktaConfigured] = useState(false)
  const [azureConfigured, setAzureConfigured] = useState(false)
  // How many of the two SSO provider checks have answered. The SSO button
  // changes the card's height, so the login logo waits for both.
  const [providerChecks, setProviderChecks] = useState(0)
  // MFA state — set after the password step returns needsMfa=true
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [mfaSecret, setMfaSecret] = useState<string | null>(null)
  const [mfaOtpauth, setMfaOtpauth] = useState<string | null>(null)
  const [mfaQrSvg, setMfaQrSvg] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [backupCodesRemaining, setBackupCodesRemaining] = useState<number | null>(null)
  const [postMfaMustChange, setPostMfaMustChange] = useState(false)

  // Drop the error params from the address bar so a refresh doesn't show the
  // message again.
  useEffect(() => {
    if (!ssoError) return
    const url = new URL(window.location.href)
    for (const p of SSO_ERROR_PARAMS) url.searchParams.delete(p)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }, [ssoError])

  useEffect(() => {
    fetch('/auth/okta/configured', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: { configured?: boolean } }) => {
        setOktaConfigured(!!j.data?.configured)
      })
      .catch(() => { /* ignore — leave Okta hidden */ })
      .finally(() => setProviderChecks((n) => n + 1))
    fetch('/auth/azure/configured', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: { configured?: boolean } }) => {
        setAzureConfigured(!!j.data?.configured)
      })
      .catch(() => { /* ignore — leave Azure hidden */ })
      .finally(() => setProviderChecks((n) => n + 1))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSsoError(null)
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json() as {
        data: {
          needsMfa?: boolean
          mfaIntent?: 'enroll' | 'verify'
          mfaToken?: string
          mustChangePassword?: boolean
        } | null
        error: string | null
      }
      if (json.error || !res.ok) {
        setError(json.error ?? 'login.errors.login_failed')
      } else if (json.data?.needsMfa && json.data.mfaToken) {
        setMfaToken(json.data.mfaToken)
        setPostMfaMustChange(!!json.data.mustChangePassword)
        if (json.data.mfaIntent === 'enroll') {
          // Fetch enrollment secret so we can render QR + secret.
          const r2 = await fetch('/auth/mfa/enroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mfaToken: json.data.mfaToken }),
          })
          const j2 = await r2.json() as { data: { secret?: string; otpauthUrl?: string; qrSvg?: string } | null; error: string | null }
          if (!r2.ok || !j2.data?.secret) { setError(j2.error ?? 'login.errors.mfa_setup_failed'); setLoading(false); return }
          setMfaSecret(j2.data.secret)
          setMfaOtpauth(j2.data.otpauthUrl ?? null)
          setMfaQrSvg(j2.data.qrSvg ?? null)
          setStep('mfa-enroll')
        } else {
          setStep('mfa-verify')
        }
      } else {
        // Should not happen — every password login now requires MFA. Fall
        // through defensively.
        onSuccess()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'errors.network')
    }
    setLoading(false)
  }

  async function submitMfaEnrollment(e: FormEvent) {
    e.preventDefault()
    if (!mfaToken || !mfaSecret) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/auth/mfa/verify-enrollment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ mfaToken, secret: mfaSecret, code: mfaCode }),
      })
      const json = await res.json() as { data: { backupCodes?: string[] } | null; error: string | null }
      if (json.error || !res.ok) { setError(json.error ?? 'login.errors.mfa_enroll_failed') }
      else if (json.data?.backupCodes) {
        setBackupCodes(json.data.backupCodes)
        setStep('mfa-enroll-show-codes')
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'errors.network') }
    setLoading(false)
  }

  async function submitMfaVerify(e: FormEvent) {
    e.preventDefault()
    if (!mfaToken) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ mfaToken, code: mfaCode }),
      })
      const json = await res.json() as { error: string | null; data?: { mfaMethod?: 'totp' | 'backup_code'; backupCodesRemaining?: number } }
      if (json.error || !res.ok) { setError(json.error ?? 'login.errors.mfa_verify_failed') }
      else {
        // If the user signed in with a backup code, pause before continuing
        // and show how many codes remain — otherwise they'd never learn the
        // count is dropping until it's too late.
        if (json.data?.mfaMethod === 'backup_code' && typeof json.data.backupCodesRemaining === 'number') {
          setBackupCodesRemaining(json.data.backupCodesRemaining)
        } else if (postMfaMustChange) { setStep('change-password') }
        else { onSuccess() }
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'errors.network') }
    setLoading(false)
  }

  function finishMfaEnrollment() {
    // User acknowledged the backup codes; session cookie is already set.
    if (postMfaMustChange) setStep('change-password')
    else onSuccess()
  }

  function downloadBackupCodes() {
    if (!backupCodes) return
    const header = t('login.mfa_backup_codes_file_title', 'ImpactIQ two-factor backup codes') + '\n' +
      t('login.mfa_backup_codes_file_account', 'Account: {{email}}', { email }) + '\n' +
      t('login.mfa_backup_codes_file_generated', 'Generated: {{ts}}', { ts: new Date().toISOString() }) + '\n' +
      t('login.mfa_backup_codes_file_note', 'Each code works once. Store them somewhere safe.') + '\n\n'
    const body = backupCodes.join('\n') + '\n'
    const blob = new Blob([header + body], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `impactiq-backup-codes-${new Date().toISOString().slice(0, 10)}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function submitChangePassword(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== newPasswordConfirm) {
      setError(t('login.password_mismatch'))
      return
    }
    const complexity = validatePasswordComplexity(newPassword)
    if (!complexity.ok) {
      setError(t('login.password_complexity_error', 'Password must satisfy: {{rules}}', { rules: complexity.failedLabels.join(', ') }))
      return
    }
    setLoading(true)
    try {
      // v1.77.1: read the CSRF cookie and forward it as X-CSRF-Token —
      // matches what src/client/lib/api.ts does for every other
      // mutating request. Without this the middleware rejected the
      // first-login password change with errors.csrf_missing.
      const csrfMatch = document.cookie.match(/(?:^|;\s*)impactiq_csrf=([^;]+)/)
      const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]!) : ''
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (csrf) headers['X-CSRF-Token'] = csrf
      const res = await fetch('/auth/change-password', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ newPassword }),
      })
      const json = await res.json() as { error: string | null }
      if (json.error || !res.ok) {
        setError(json.error ?? 'login.errors.password_change_failed')
      } else {
        onSuccess()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'errors.network')
    }
    setLoading(false)
  }

  return (
    <AuthShell contentReady={providerChecks >= 2}>
      <div className={`w-full rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 ${step === 'mfa-enroll' ? 'max-w-md' : 'max-w-sm'}`}>
          {step === 'login' ? (
            <>
              <div className="mb-6 flex items-center gap-3">
                <img
                  src="/logo-9-iq-spark-arcs.svg"
                  alt="ImpactIQ"
                  className="h-10 w-10 shrink-0"
                />
                <div>
                  <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('login.title')}</h1>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('login.subtitle')}</p>
                </div>
              </div>

              {ssoError && (
                <div role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="text-xs">{t(ssoError.reason, { provider: ssoError.provider })}</span>
                </div>
              )}

              {(oktaConfigured || azureConfigured) && (
                <>
                  <SsoSignIn oktaConfigured={oktaConfigured} azureConfigured={azureConfigured} />
                  <div className="mb-4 flex items-center gap-2 text-[10px] uppercase tracking-wide text-gray-400">
                    <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                    {t('auth.or_local')}
                    <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                  </div>
                </>
              )}

              <form onSubmit={submit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">{t('login.email')}</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value.trim())}
                    required
                    autoFocus
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">{t('login.password')}</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="text-xs">{translateError(error)}</span>
                  </div>
                )}

                <Button type="submit" disabled={loading || !email || !password} className="w-full">
                  {loading ? <Spinner className="mr-2 h-3 w-3" /> : null}
                  {t('login.submit')}
                </Button>

                {/* v1.116.0: forgot-password link. Server accepts any
                    email and responds neutrally, so exposing this to
                    Okta-only accounts is fine — they just never
                    receive a reset email. */}
                <p className="text-center text-xs">
                  <a href="/forgot-password" className="text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300">
                    {t('login.forgot_password', 'Forgot password?')}
                  </a>
                </p>
              </form>
            </>
          ) : step === 'mfa-enroll' ? (
            <>
              <div className="mb-6 flex items-start gap-3">
                <div className="rounded-md bg-indigo-100 p-2 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="whitespace-nowrap text-xl font-semibold text-gray-900 dark:text-gray-100">{t('login.mfa_enroll_title')}</h1>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('login.mfa_enroll_subtitle')}</p>
                </div>
              </div>
              <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
                {mfaQrSvg && (
                  <div className="mb-3 flex justify-center">
                    <div
                      className="rounded-md bg-white p-2"
                      // qrcode's toString({ type: 'svg' }) returns a full <svg> element with
                      // black-on-white paths — safe to drop directly into the DOM.
                      dangerouslySetInnerHTML={{ __html: mfaQrSvg }}
                    />
                  </div>
                )}
                <p className="mb-2 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">{t('login.mfa_secret_label')}</p>
                <code className="block break-all rounded bg-white p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100">{mfaSecret}</code>
                <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{t('login.mfa_enroll_scan_hint')}</p>
              </div>
              <form onSubmit={submitMfaEnrollment} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mfaEnrollCode">{t('login.mfa_code_label')}</Label>
                  <Input id="mfaEnrollCode" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required autoFocus />
                </div>
                {error && <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{translateError(error)}</span></div>}
                <Button type="submit" disabled={loading || mfaCode.length !== 6} className="w-full">
                  {loading ? <Spinner className="mr-2 h-3 w-3" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  {t('login.mfa_verify_button')}
                </Button>
              </form>
            </>
          ) : step === 'mfa-enroll-show-codes' ? (
            <>
              <div className="mb-6 flex items-start gap-3">
                <div className="rounded-md bg-indigo-100 p-2 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('login.mfa_backup_codes_title')}</h1>
                  <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">{t('login.mfa_backup_codes_warning')}</p>
                </div>
              </div>
              <div className="mb-4 grid grid-cols-2 gap-2 rounded-md border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
                {(backupCodes ?? []).map((c) => (
                  <code key={c} className="rounded bg-white px-2 py-1 text-center text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100">{c}</code>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <Button type="button" variant="outline" onClick={downloadBackupCodes} className="w-full">
                  <Download className="mr-2 h-4 w-4" />{t('login.mfa_backup_codes_download')}
                </Button>
                <Button type="button" onClick={finishMfaEnrollment} className="w-full">
                  <Check className="mr-2 h-4 w-4" />{t('login.mfa_backup_codes_continue')}
                </Button>
              </div>
            </>
          ) : step === 'mfa-verify' ? (
            <>
              <div className="mb-6 flex items-start gap-3">
                <div className="rounded-md bg-indigo-100 p-2 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('login.mfa_verify_title')}</h1>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('login.mfa_verify_subtitle')}</p>
                </div>
              </div>
              {backupCodesRemaining !== null ? (
                <div className="flex flex-col gap-4">
                  <div className={`flex items-start gap-2 rounded-md border px-3 py-3 text-sm ${
                    backupCodesRemaining === 0
                      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
                      : backupCodesRemaining <= 3
                      ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                      : 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                  }`}>
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-semibold">{t('login.backup_code_used', 'Backup code accepted')}</p>
                      <p className="text-xs">
                        {backupCodesRemaining === 0
                          ? t('login.backup_codes_none_left', "That was your last backup code. Regenerate new codes from your account settings before you're locked out.")
                          : t('login.backup_codes_remaining', { count: backupCodesRemaining, defaultValue: '{{count}} backup codes remaining. Consider regenerating them from your account settings.' })}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={() => { setBackupCodesRemaining(null); if (postMfaMustChange) setStep('change-password'); else onSuccess() }}
                    className="w-full"
                  >
                    {t('login.continue', 'Continue')}
                  </Button>
                </div>
              ) : (
              <form onSubmit={submitMfaVerify} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mfaVerifyCode">{t('login.mfa_code_or_backup_label')}</Label>
                  <Input id="mfaVerifyCode" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required autoFocus placeholder="123456 or ABCDE-FGHI-JKLM" />
                </div>
                {error && <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{translateError(error)}</span></div>}
                <Button type="submit" disabled={loading || mfaCode.length === 0} className="w-full">
                  {loading ? <Spinner className="mr-2 h-3 w-3" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  {t('login.mfa_verify_button')}
                </Button>
              </form>
              )}
            </>
          ) : (
            <>
              <div className="mb-6 flex items-center gap-3">
                <img
                  src="/logo-9-iq-spark-arcs.svg"
                  alt="ImpactIQ"
                  className="h-10 w-10 shrink-0"
                />
                <div>
                  <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('login.set_new_password')}</h1>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('login.set_new_password_subtitle')}</p>
                </div>
              </div>

              <form onSubmit={submitChangePassword} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="newPassword">{t('login.new_password')}</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoFocus
                  />
                  <ul className="mt-1 flex flex-col gap-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                    {PASSWORD_RULES.map((r) => {
                      const passed = r.test(newPassword)
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
                  <Label htmlFor="newPasswordConfirm">{t('login.confirm_password')}</Label>
                  <Input
                    id="newPasswordConfirm"
                    type="password"
                    autoComplete="new-password"
                    value={newPasswordConfirm}
                    onChange={(e) => setNewPasswordConfirm(e.target.value)}
                    required
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="text-xs">{translateError(error)}</span>
                  </div>
                )}

                <Button type="submit" disabled={loading || !newPassword || !newPasswordConfirm} className="w-full">
                  {loading ? <Spinner className="mr-2 h-3 w-3" /> : null}
                  {t('login.set_password_submit')}
                </Button>
              </form>
            </>
          )}
      </div>
    </AuthShell>
  )
}
