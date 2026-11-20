// FX rate service.
//
// Fetches daily reference rates from the European Central Bank (free, no API
// key, quoted vs EUR) and re-anchors them to USD so the resolver's cost math
// stays currency-agnostic. Rates are stored in `fx_rates` keyed by
// (currency, as_of), so re-running on the same day is idempotent.

import { db } from '../../db/index.js'
import { fxRates } from '../../../../drizzle/schema.js'
import { eq, desc, and } from 'drizzle-orm'

// Public FX feeds we try in order. The first two are USD-anchored JSON
// feeds that don't require an API key. ECB is the fallback and returns
// EUR-anchored XML that we re-anchor to USD.
const OPEN_ER_API_URL = 'https://open.er-api.com/v6/latest/USD'
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD'
const ECB_XML_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

interface FetchAttempt { source: string; ok: boolean; detail: string; asOf?: string; rates?: Array<{ currency: string; ratePerUsd: number }> }

async function tryOpenErApi(): Promise<FetchAttempt> {
  try {
    const res = await fetch(OPEN_ER_API_URL)
    if (!res.ok) return { source: 'open.er-api.com', ok: false, detail: `HTTP ${res.status}` }
    const body = await res.json() as { result?: string; time_last_update_utc?: string; rates?: Record<string, number> }
    if (body.result !== 'success' || !body.rates) {
      return { source: 'open.er-api.com', ok: false, detail: `unexpected body (${body.result ?? 'no result'})` }
    }
    const asOf = body.time_last_update_utc ? new Date(body.time_last_update_utc).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
    const rates = Object.entries(body.rates).map(([currency, ratePerUsd]) => ({ currency, ratePerUsd }))
    return { source: 'open.er-api.com', ok: true, detail: `${rates.length} rates`, asOf, rates }
  } catch (err) {
    return { source: 'open.er-api.com', ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

async function tryFrankfurter(): Promise<FetchAttempt> {
  try {
    const res = await fetch(FRANKFURTER_URL)
    if (!res.ok) return { source: 'frankfurter.app', ok: false, detail: `HTTP ${res.status}` }
    const body = await res.json() as { date?: string; rates?: Record<string, number> }
    if (!body.rates) return { source: 'frankfurter.app', ok: false, detail: 'no rates in response' }
    const asOf = body.date ?? new Date().toISOString().slice(0, 10)
    const rates: Array<{ currency: string; ratePerUsd: number }> = [
      { currency: 'USD', ratePerUsd: 1 },
      ...Object.entries(body.rates).map(([currency, ratePerUsd]) => ({ currency, ratePerUsd })),
    ]
    return { source: 'frankfurter.app', ok: true, detail: `${rates.length} rates`, asOf, rates }
  } catch (err) {
    return { source: 'frankfurter.app', ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

async function tryEcb(): Promise<FetchAttempt> {
  try {
    const res = await fetch(ECB_XML_URL)
    if (!res.ok) return { source: 'ecb.europa.eu', ok: false, detail: `HTTP ${res.status}` }
    const xml = await res.text()
    const timeMatch = xml.match(/<Cube time="([^"]+)">/)
    const asOf = timeMatch?.[1] ?? new Date().toISOString().slice(0, 10)
    const parsed: Array<{ currency: string; rate: number }> = []
    const rateRe = /<Cube currency="([^"]+)" rate="([^"]+)"\/>/g
    let m: RegExpExecArray | null
    while ((m = rateRe.exec(xml)) !== null) {
      parsed.push({ currency: m[1]!, rate: Number(m[2]!) })
    }
    if (parsed.length === 0) return { source: 'ecb.europa.eu', ok: false, detail: `response did not look like ECB XML (${xml.slice(0, 80).replace(/\s+/g, ' ')})` }
    const usdPerEur = parsed.find((r) => r.currency === 'USD')?.rate
    if (!usdPerEur) return { source: 'ecb.europa.eu', ok: false, detail: 'feed missing USD rate' }
    const rates: Array<{ currency: string; ratePerUsd: number }> = [
      { currency: 'USD', ratePerUsd: 1 },
      { currency: 'EUR', ratePerUsd: 1 / usdPerEur },
    ]
    for (const r of parsed) if (r.currency !== 'USD') rates.push({ currency: r.currency, ratePerUsd: r.rate / usdPerEur })
    return { source: 'ecb.europa.eu', ok: true, detail: `${rates.length} rates`, asOf, rates }
  } catch (err) {
    return { source: 'ecb.europa.eu', ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export async function refreshFxRates(): Promise<{ inserted: number; asOf: string; source: string; attempts: Array<{ source: string; ok: boolean; detail: string }> }> {
  const attempts: FetchAttempt[] = []
  for (const attempt of [tryOpenErApi, tryFrankfurter, tryEcb]) {
    const r = await attempt()
    attempts.push(r)
    if (r.ok && r.rates && r.asOf) {
      return { ...(await persistRates(r.rates, r.asOf, r.source)), source: r.source, attempts: attempts.map(({ source, ok, detail }) => ({ source, ok, detail })) }
    }
  }
  // All sources failed — throw a diagnostic-rich error that the admin
  // route can bubble up as the response `error`.
  const summary = attempts.map((a) => `${a.source}: ${a.detail}`).join(' | ')
  throw new Error(`All FX sources failed — ${summary}`)
}

async function persistRates(anchored: Array<{ currency: string; ratePerUsd: number }>, asOf: string, sourceLabel: string): Promise<{ inserted: number; asOf: string }> {
  let inserted = 0
  for (const a of anchored) {
    // Upsert on (currency, as_of).
    const existing = await db
      .select({ id: fxRates.id })
      .from(fxRates)
      .where(and(eq(fxRates.currency, a.currency), eq(fxRates.asOf, asOf)))
      .limit(1)
    if (existing.length > 0) {
      await db.update(fxRates)
        .set({ ratePerUsd: a.ratePerUsd.toFixed(8), source: sourceLabel })
        .where(eq(fxRates.id, existing[0]!.id))
    } else {
      await db.insert(fxRates).values({
        currency: a.currency,
        ratePerUsd: a.ratePerUsd.toFixed(8),
        source: 'ecb',
        asOf,
      })
      inserted++
    }
  }
  return { inserted, asOf }
}

// Return the freshest rate we have for the given currency, or null if we
// have never fetched one. `1` is returned as-is for USD without a DB hit.
export async function latestRatePerUsd(currency: string): Promise<number | null> {
  if (currency === 'USD') return 1
  const rows = await db
    .select({ rate: fxRates.ratePerUsd })
    .from(fxRates)
    .where(eq(fxRates.currency, currency))
    .orderBy(desc(fxRates.asOf))
    .limit(1)
  const r = rows[0]
  return r ? Number(r.rate) : null
}

export async function listLatestRates(): Promise<Array<{ currency: string; ratePerUsd: number; asOf: string; source: string }>> {
  // One row per currency, freshest date. Small table so a full scan +
  // in-memory grouping is fine.
  const rows = await db
    .select({ currency: fxRates.currency, ratePerUsd: fxRates.ratePerUsd, asOf: fxRates.asOf, source: fxRates.source })
    .from(fxRates)
    .orderBy(desc(fxRates.asOf))
  const seen = new Set<string>()
  const out: Array<{ currency: string; ratePerUsd: number; asOf: string; source: string }> = []
  for (const r of rows) {
    if (seen.has(r.currency)) continue
    seen.add(r.currency)
    out.push({ currency: r.currency, ratePerUsd: Number(r.ratePerUsd), asOf: r.asOf, source: r.source })
  }
  return out
}
