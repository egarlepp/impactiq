import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Suspense, lazy, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, AlertCircle, X } from 'lucide-react'
import { AppNav } from './components/ui/nav.js'
import { Spinner } from './components/ui/spinner.js'
import { useTheme } from './store/theme.js'
import { TeamProvider } from './store/team.js'
import { useCrmProvider } from './store/crmProvider.js'
import { useTerminology } from './store/terminology.js'
import { usePrintInLightMode } from './hooks/usePrintInLightMode.js'
import { setBrandLogos, applyThemeColors, setSupportEmail, type ActiveThemeColors } from './store/branding.js'
import { NotificationToast } from './components/ui/notifications.js'
import { ConnectionsBanner } from './components/ui/connections-banner.js'
import { MaintenanceBanner } from './components/ui/MaintenanceBanner.js'
import { AnnouncementBanner } from './components/ui/AnnouncementBanner.js'
import { OpportunityDeepLink } from './components/salesforce/OpportunityDeepLink.js'
import { FlightDeckModal } from './components/flightdeck/FlightDeckModal.js'

const WeeklyView = lazy(() => import('./pages/WeeklyView.js'))
const Dashboard = lazy(() => import('./pages/Dashboard.js'))
const Admin = lazy(() => import('./pages/Admin.js'))
const Settings = lazy(() => import('./pages/Settings.js'))
const MyNotes = lazy(() => import('./pages/MyNotes.js'))
const MyHistory = lazy(() => import('./pages/MyHistory.js'))
const Guide = lazy(() => import('./pages/Guide.js'))
const HowToUseImpactIQ = lazy(() => import('./pages/HowToUseImpactIQ.js'))
const Scheduling = lazy(() => import('./pages/Scheduling.js'))
const NotFound = lazy(() => import('./pages/NotFound.js'))
const Setup = lazy(() => import('./pages/Setup.js'))
const Login = lazy(() => import('./pages/Login.js'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.js'))
const ResetPassword = lazy(() => import('./pages/ResetPassword.js'))
const FirstRun = lazy(() => import('./pages/FirstRun.js'))

function PageShell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme()
  // Loads the install's CRM once, which points {{crm}} in every string at it.
  useCrmProvider()
  // Same for {{evalTerm}} / {{evalWork}} (Admin → Workplace → Terminology).
  useTerminology()
  usePrintInLightMode()
  return (
    <div
      className="flex h-screen overflow-hidden bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100"
      style={{
        backgroundColor:
          theme === 'dark'
            ? 'var(--color-page-bg-dark, #030712)'
            : 'var(--color-page-bg-light, #f9fafb)',
      }}
    >
      <AppNav />
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Banners and toasts are on-screen notices, never part of a printout. */}
        <div className="contents print:hidden">
          <MaintenanceBanner />
          <ConnectionsBanner />
          <AnnouncementBanner />
          <ConnectToast />
        </div>
        {children}
      </main>
      <div className="contents print:hidden">
        <NotificationToast />
        <FlightDeckModal />
        <OpportunityDeepLink />
      </div>
    </div>
  )
}

function ConnectToast() {
  const { t } = useTranslation()
  const location = useLocation()
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; provider: 'sf' | 'ms'; reason?: string } | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const sf = params.get('sfConnect')
    const ms = params.get('msConnect')
    const reason = params.get('reason') ?? undefined
    let next: { kind: 'success' | 'error'; provider: 'sf' | 'ms'; reason?: string } | null = null
    if (sf === 'success' || sf === 'error') next = { kind: sf, provider: 'sf', reason }
    else if (ms === 'success' || ms === 'error') next = { kind: ms, provider: 'ms', reason }
    if (!next) return
    setToast(next)
    params.delete('sfConnect')
    params.delete('msConnect')
    params.delete('reason')
    const newSearch = params.toString()
    window.history.replaceState({}, '', location.pathname + (newSearch ? `?${newSearch}` : ''))
  }, [location.pathname, location.search])

  if (!toast) return null

  const isSuccess = toast.kind === 'success'
  const successKey = toast.provider === 'sf' ? 'sf.connect.toast_success' : 'calendar.toast_success'
  const errorKey = toast.provider === 'sf' ? 'sf.connect.toast_error' : 'calendar.toast_error'

  return (
    <div className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${
      isSuccess
        ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300'
        : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
    }`}>
      {isSuccess ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="flex-1">
        {isSuccess ? t(successKey) : t(errorKey, { reason: toast.reason?.startsWith('errors.') ? t(toast.reason) : (toast.reason ?? 'unknown error') })}
      </span>
      <button onClick={() => setToast(null)} className="shrink-0 opacity-60 hover:opacity-100" aria-label="close">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  )
}

type AppState =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'db-error'; message: string }
  | { kind: 'unauthenticated' }
  | { kind: 'first-run' }
  | { kind: 'must-change-password' }
  | { kind: 'authenticated' }

function useAppState(): { state: AppState; refresh: () => void } {
  const [state, setState] = useState<AppState>({ kind: 'loading' })

  const refresh = useCallback(() => {
    setState({ kind: 'loading' })
    fetch('/health')
      .then((r) => r.json())
      .then(async (j: { data?: { setupMode?: boolean; dbError?: string | null } }) => {
        if (j.data?.setupMode) {
          setState({ kind: 'setup' })
          return
        }
        // v1.247.0: DATABASE_URL being set and being reachable are
        // different conditions (wrong password/host/db name all leave
        // setupMode false) — the server now stays up and reports this on
        // /health + every /api or /auth call instead of crash-looping with
        // no live listener (which is what showed up as a permanent Bad
        // Gateway from the reverse proxy). Route to a dedicated full-page
        // message rather than falling through to /auth/me, which would
        // just 503 with the same error but leave the user staring at a
        // blank/broken login page.
        if (j.data?.dbError) {
          setState({ kind: 'db-error', message: j.data.dbError })
          return
        }
        const me = await fetch('/auth/me', { credentials: 'same-origin' })
        if (!me.ok) {
          // v1.475.0: no account exists yet (DATABASE_URL was set from the
          // start, so the /setup wizard never ran): offer the first admin.
          const firstRun = await fetch('/api/first-run/status', { credentials: 'same-origin' })
            .then((r) => r.json() as Promise<{ data?: { needsAdmin?: boolean } | null }>)
            .catch(() => null)
          setState({ kind: firstRun?.data?.needsAdmin ? 'first-run' : 'unauthenticated' })
          return
        }
        const meJson = await me.json().catch(() => null) as { data?: { mustChangePassword?: boolean } } | null
        if (meJson?.data?.mustChangePassword) {
          setState({ kind: 'must-change-password' })
          return
        }
        setState({ kind: 'authenticated' })
      })
      .catch(() => { setState({ kind: 'unauthenticated' }) })
  }, [])

  useEffect(() => { refresh() }, [refresh])
  return { state, refresh }
}

function AppGate({ children, state, refresh }: { children: React.ReactNode; state: AppState; refresh: () => void }) {
  const location = useLocation()
  const { t } = useTranslation()

  if (state.kind === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (state.kind === 'setup') {
    if (location.pathname !== '/setup') return <Navigate to="/setup" replace />
    return <>{children}</>
  }

  if (state.kind === 'db-error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center dark:bg-gray-950">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('app.db_error.title', 'Database is configured but unreachable')}</h1>
        <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">{t('app.db_error.hint', 'DATABASE_URL is set, but the app couldn\'t connect. Double-check the host, credentials, and database name, then redeploy.')}</p>
        <pre className="max-w-lg overflow-x-auto rounded-md border border-red-200 bg-red-50 px-3 py-2 text-left text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{state.message}</pre>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          {t('app.db_error.retry', 'Retry')}
        </button>
      </div>
    )
  }

  if (state.kind === 'first-run') return <FirstRun onDone={refresh} />

  if (state.kind === 'unauthenticated') {
    // v1.116.0: pre-auth pages that bypass the Login gate.
    if (location.pathname === '/forgot-password') return <ForgotPassword />
    if (location.pathname === '/reset-password') return <ResetPassword />
    return <Login onSuccess={refresh} />
  }

  if (state.kind === 'must-change-password') {
    return <Login onSuccess={refresh} forceChangePassword />
  }

  if (location.pathname === '/setup') return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  useTheme()
  const { state, refresh } = useAppState()

  useEffect(() => {
    fetch('/api/themes/active', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: { colors?: ActiveThemeColors | null; logoLight?: string | null; logoDark?: string | null } | null }) => {
        if (j.data?.colors) applyThemeColors(j.data.colors)
        setBrandLogos({ logoLight: j.data?.logoLight ?? null, logoDark: j.data?.logoDark ?? null })
      })
      .catch(() => { /* no active theme — keep defaults */ })
    fetch('/api/themes/support-email', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: { email?: string | null } | null }) => setSupportEmail(j.data?.email ?? null))
      .catch(() => { /* keep hidden */ })
  }, [])

  return (
    <BrowserRouter>
      <AppGate state={state} refresh={refresh}>
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            <Route
              path="/setup"
              element={
                <div className="h-screen overflow-y-auto">
                  <Setup />
                </div>
              }
            />
            <Route
              path="/*"
              element={
                <TeamProvider>
                  <PageShell>
                    <Routes>
                      <Route path="/" element={<WeeklyView />} />
                      <Route path="/activities" element={<WeeklyView />} />
                      <Route path="/dashboard" element={<Dashboard />} />
                      <Route path="/scheduling" element={<Scheduling />} />
                      <Route path="/admin" element={<Admin />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/notes" element={<MyNotes />} />
                      <Route path="/my-history" element={<MyHistory />} />
                      <Route path="/guide" element={<Guide />} />
                      <Route path="/guide/how-to-use" element={<HowToUseImpactIQ />} />
                      <Route path="*" element={<NotFound />} />
                    </Routes>
                  </PageShell>
                </TeamProvider>
              }
            />
          </Routes>
        </Suspense>
      </AppGate>
    </BrowserRouter>
  )
}
