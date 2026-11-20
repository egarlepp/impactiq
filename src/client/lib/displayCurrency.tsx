import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderClock } from 'lucide-react'
import { api } from './api.js'
import { SingleSelect } from '../components/ui/single-select.js'
import { CURRENCIES } from '../components/admin/common-lists.js'

// Shared "Show Costs In" display currency for every cost/currency dashboard.
// Lifted out of the individual dashboards so the selector + FX-date pill live
// once in the page header. Seeded from the user's My-Settings preferred
// currency; changes are session-only (they do not rewrite the saved
// preference).

interface FxStatus {
  asOf: string | null
  source: string | null
  count: number
  fxRates: Record<string, { ratePerUsd: number; asOf: string }>
  availableCurrencies: string[]
}

interface DisplayCurrencyValue {
  currency: string
  setCurrency: (c: string) => void
  fxRates: Record<string, { ratePerUsd: number; asOf: string }>
  availableCurrencies: string[]
  fxAsOf: string | null
  fxSource: string | null
  /** true when the selected currency has no cached FX rate (values fall back to USD). */
  missing: boolean
  /** Convert a USD amount into the selected display currency. */
  toDisplay: (usd: number) => number
  /** Format a USD amount in the selected display currency. */
  fmt: (usd: number) => string
}

export const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', AUD: 'A$', CAD: 'C$',
  CHF: 'Fr.', HKD: 'HK$', SGD: 'S$', KRW: '₩', INR: '₹', MXN: 'Mex$',
  BRL: 'R$', TWD: 'NT$', ZAR: 'R', AED: 'د.إ', SAR: '﷼',
}

export function formatCurrency(n: number, currency: string): string {
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })
  } catch {
    const sym = CURRENCY_SYMBOL[currency] ?? currency + ' '
    return `${sym}${Math.round(n).toLocaleString('en-US')}`
  }
}

const DisplayCurrencyContext = createContext<DisplayCurrencyValue | null>(null)

export function DisplayCurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrency] = useState<string>('USD')
  const [fx, setFx] = useState<FxStatus>({ asOf: null, source: null, count: 0, fxRates: {}, availableCurrencies: ['USD'] })

  useEffect(() => {
    let cancelled = false
    void api.get<FxStatus>('/api/dashboards/fx-status').then((res) => {
      if (!cancelled && res.data) setFx(res.data)
    })
    // Seed from the user's saved preferred currency (session-only — we never
    // write it back from here).
    void api.get<{ code: string | null }>('/auth/me/preferred-currency').then((res) => {
      if (!cancelled && res.data?.code) setCurrency(res.data.code)
    })
    return () => { cancelled = true }
  }, [])

  const ratePerUsd = currency === 'USD' ? 1 : (fx.fxRates[currency]?.ratePerUsd ?? 1)
  const missing = currency !== 'USD' && !fx.fxRates[currency]
  const toDisplay = useCallback((usd: number) => usd * ratePerUsd, [ratePerUsd])
  const fmt = useCallback((usd: number) => formatCurrency(usd * ratePerUsd, missing ? 'USD' : currency), [ratePerUsd, currency, missing])

  const value = useMemo<DisplayCurrencyValue>(() => ({
    currency,
    setCurrency,
    fxRates: fx.fxRates,
    availableCurrencies: fx.availableCurrencies,
    fxAsOf: fx.asOf,
    fxSource: fx.source,
    missing,
    toDisplay,
    fmt,
  }), [currency, fx, missing, toDisplay, fmt])

  return <DisplayCurrencyContext.Provider value={value}>{children}</DisplayCurrencyContext.Provider>
}

export function useDisplayCurrency(): DisplayCurrencyValue {
  const ctx = useContext(DisplayCurrencyContext)
  if (!ctx) throw new Error('useDisplayCurrency must be used within DisplayCurrencyProvider')
  return ctx
}

// Shared "Show Costs In" selector + FX-date pill rendered once in the page
// header for any cost/currency dashboard. Currencies with a cached FX rate
// float to the top; the rest are shown with a "no rate" hint.
export function DisplayCurrencyControls() {
  const { t } = useTranslation()
  const { currency, setCurrency, availableCurrencies, fxAsOf, fxSource } = useDisplayCurrency()
  const withRates = new Set([...(availableCurrencies ?? []), 'USD'])
  const withCached = CURRENCIES.filter((c) => withRates.has(c.code)).map((c) => ({ ...c, hasRate: true }))
  const cachedCodes = new Set(withCached.map((c) => c.code))
  const rest = CURRENCIES.filter((c) => !cachedCodes.has(c.code)).map((c) => ({ ...c, hasRate: false }))
  const options = [...withCached, ...rest]
  return (
    <div className="flex items-center gap-2">
      <SingleSelect
        label={t('leader.cost_per_acv.currency_label', 'Show Costs In')}
        value={currency}
        onChange={setCurrency}
        options={options.map((c) => ({
          value: c.code,
          label: `${CURRENCY_SYMBOL[c.code] ?? ''} ${c.code} — ${c.name}`,
          hint: !c.hasRate && c.code !== 'USD' ? t('leader.cost_per_acv.no_rate', 'no rate') : undefined,
        }))}
      />
      {fxAsOf && (
        <span
          title={t('leader.cost_per_acv.fx_status_tooltip', 'FX rates last refreshed {{asOf}}{{source}}', { asOf: fxAsOf, source: fxSource ? ` — ${fxSource}` : '' })}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400"
        >
          <FolderClock className="h-3.5 w-3.5" />
          {t('leader.cost_per_acv.fx_status_label', 'FX {{asOf}}', { asOf: fxAsOf })}
        </span>
      )}
    </div>
  )
}
