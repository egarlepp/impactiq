import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mail, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Spinner } from '../components/ui/spinner.js'
import { api } from '../lib/api.js'
import { AuthShell } from '../components/auth/AuthShell.js'

// v1.116.0: pre-auth page. Accepts an email address and asks the server
// to email a reset link. The server response is intentionally neutral
// — it always claims "if an account exists, we sent a link" so an
// attacker can't enumerate users. Okta / SSO-only accounts are
// silently skipped on the server side.
export default function ForgotPassword() {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null); setLoading(true)
    const res = await api.post<{ ok: boolean; message: string }>('/auth/forgot-password', { email: email.trim() })
    setLoading(false)
    if (res.error) { setError(res.error); return }
    setSent(true)
  }

  return (
    <AuthShell>
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <Mail className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          {t('forgot_password.title', 'Reset your ImpactIQ password')}
        </div>
        {sent ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="text-xs">{t('forgot_password.sent', 'If an account exists for that email, a reset link has been sent. Check your inbox (and spam). The link expires in 60 minutes and only works once.')}</span>
            </div>
            <a href="/" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400">
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('forgot_password.back_to_login', 'Back to sign-in')}
            </a>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('forgot_password.description', 'Enter the email associated with your ImpactIQ account. If the account exists and can sign in with a password, we\'ll send a reset link that expires in 60 minutes.')}
            </p>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('forgot_password.email_label', 'Email')}
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus className="mt-1" />
            </label>
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <Button type="submit" disabled={loading || !email.trim()} className="w-full">
              {loading ? <Spinner className="mr-2 h-3 w-3" /> : null}
              {t('forgot_password.submit', 'Send reset link')}
            </Button>
            <a href="/" className="inline-flex items-center gap-1 text-center text-xs text-blue-600 hover:underline dark:text-blue-400">
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('forgot_password.back_to_login', 'Back to sign-in')}
            </a>
          </form>
        )}
      </div>
    </AuthShell>
  )
}
