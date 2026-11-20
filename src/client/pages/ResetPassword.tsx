import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Key, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Spinner } from '../components/ui/spinner.js'
import { api } from '../lib/api.js'
import { validatePasswordComplexity, PASSWORD_RULES } from '../../shared/schemas/password.js'
import { translateServerError } from '../lib/errors.js'
import { AuthShell } from '../components/auth/AuthShell.js'

// v1.116.0: pre-auth reset page. Consumes the token from the query
// string, verifies it once on mount, then lets the user set a new
// password. On success the server invalidates every existing session
// for the user so the next sign-in re-runs both password + MFA.
export default function ResetPassword() {
  const { t, i18n } = useTranslation()
  const [token, setToken] = useState<string>('')
  const [verified, setVerified] = useState<null | { displayName: string; email: string }>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const tok = params.get('token') ?? ''
    setToken(tok)
    if (!tok) { setVerifyError(t('reset_password.no_token', 'Missing reset token in URL')); return }
    void api.post<{ ok: boolean; displayName: string; email: string }>('/auth/reset-password/verify', { token: tok })
      .then((res) => {
        if (res.error) setVerifyError(res.error)
        else if (res.data) setVerified({ displayName: res.data.displayName, email: res.data.email })
      })
  }, [t])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirm) { setError(t('reset_password.mismatch', 'Passwords do not match')); return }
    const complexity = validatePasswordComplexity(newPassword)
    if (!complexity.ok) { setError(t('reset_password.complexity_error', 'Password must satisfy: {{rules}}', { rules: complexity.failedLabels.join(', ') })); return }
    setLoading(true)
    const res = await api.post<{ ok: boolean }>('/auth/reset-password', { token, newPassword })
    setLoading(false)
    if (res.error) { setError(res.error); return }
    setDone(true)
  }

  return (
    <AuthShell>
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <Key className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          {t('reset_password.title', 'Set a new password')}
        </div>
        {verifyError ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{translateServerError(t, i18n, verifyError)}. {t('reset_password.expired_hint', 'Request a new reset link from the sign-in page.')}</span>
            </div>
            <a href="/forgot-password" className="text-center text-xs text-blue-600 hover:underline dark:text-blue-400">
              {t('reset_password.request_new', 'Request a new reset link')}
            </a>
          </div>
        ) : done ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="text-xs">{t('reset_password.done', 'Your password has been changed. All existing sessions are signed out. Sign in again with your new password.')}</span>
            </div>
            <a href="/" className="inline-flex items-center justify-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700">
              {t('reset_password.to_login', 'Go to sign-in')}
            </a>
          </div>
        ) : !verified ? (
          <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('reset_password.for_user', 'Setting a new password for')}{' '}
              <b>{verified.displayName}</b> ({verified.email}).
            </p>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('reset_password.new_label', 'New password')}
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required className="mt-1" />
            </label>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('reset_password.confirm_label', 'Confirm new password')}
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="mt-1" />
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
            <Button type="submit" disabled={loading || !newPassword || !confirm} className="w-full">
              {loading ? <Spinner className="mr-2 h-3 w-3" /> : null}
              {t('reset_password.submit', 'Set new password')}
            </Button>
          </form>
        )}
      </div>
    </AuthShell>
  )
}
