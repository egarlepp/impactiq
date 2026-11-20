import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, LogIn, ShieldCheck, UserPlus } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Spinner } from '../components/ui/spinner.js'
import { api } from '../lib/api.js'
import { validatePasswordComplexity, PASSWORD_RULES } from '../../shared/schemas/password.js'
import { translateServerError } from '../lib/errors.js'
import { AuthShell } from '../components/auth/AuthShell.js'

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// v1.475.0: shown instead of the sign-in page while the install has no
// account at all (DATABASE_URL was set from the start, so the /setup wizard
// never ran). Creates the first App Admin with the setup token the server
// printed to its log. See services/auth/firstRun.ts.
export default function FirstRun({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const [token, setToken] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!EMAIL_RX.test(email.trim())) { setError(t('first_run.invalid_email')); return }
    if (password !== confirm) { setError(t('first_run.mismatch')); return }
    const complexity = validatePasswordComplexity(password)
    if (!complexity.ok) { setError(t('first_run.complexity_error', { rules: complexity.failedLabels.join(', ') })); return }
    setSaving(true)
    const res = await api.post<{ ok: boolean }>(
      '/api/first-run/admin',
      { email: email.trim(), displayName: displayName.trim(), password },
      { 'X-Setup-Token': token.trim() },
    )
    setSaving(false)
    if (res.error) {
      // Someone else finished first: go to the normal sign-in page.
      if (res.error === 'errors.first_run.already_done' || res.error === t('errors.first_run.already_done')) { onDone(); return }
      setError(res.error)
      return
    }
    setDone(true)
  }

  const canSubmit = token.trim() !== '' && displayName.trim() !== '' && email.trim() !== '' && password !== '' && confirm !== ''

  return (
    <AuthShell>
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-2 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          {t('first_run.title')}
        </div>
        {done ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="text-xs">{t('first_run.done')}</span>
            </div>
            <Button type="button" onClick={onDone} className="w-full">
              <LogIn className="mr-2 h-4 w-4" />
              {t('first_run.to_login')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('first_run.intro')}</p>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('first_run.token_label')}
              <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required className="mt-1 font-mono" />
              <span className="mt-1 block text-[10px] font-normal text-gray-500 dark:text-gray-400">{t('first_run.token_hint')}</span>
            </label>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('first_run.name_label')}
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" required className="mt-1" />
            </label>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('first_run.email_label')}
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required className="mt-1" />
            </label>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('first_run.password_label')}
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required className="mt-1" />
            </label>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('first_run.confirm_label')}
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required className="mt-1" />
            </label>
            <ul className="ml-4 list-disc text-[10px] text-gray-500 dark:text-gray-400">
              {PASSWORD_RULES.map((r) => (
                <li key={r.key}>{r.label}</li>
              ))}
            </ul>
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{translateServerError(t, i18n, error)}</span>
              </div>
            )}
            <Button type="submit" disabled={saving || !canSubmit} className="w-full">
              {saving ? <Spinner className="mr-2 h-3 w-3" /> : <UserPlus className="mr-2 h-4 w-4" />}
              {t('first_run.submit')}
            </Button>
          </form>
        )}
      </div>
    </AuthShell>
  )
}
