import i18n from '../i18n/index.js'

export interface ApiResponse<T> {
  data: T | null
  error: string | null
  meta: Record<string, unknown>
}

// When the server returns an error of the form 'errors.foo' (or
// 'errors.foo|key1=val1|key2=val2'), translate via i18next before
// surfacing it to UI code. Free-text English errors from older paths
// pass through unchanged so nothing regresses.
export function localizeError(raw: string | null): string | null {
  if (!raw || !raw.startsWith('errors.')) return raw
  const parts = raw.split('|')
  const key = parts[0]!
  const paramParts = parts.slice(1)
  const params: Record<string, string> = {}
  for (const p of paramParts) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq)] = p.slice(eq + 1)
  }
  const translated = i18n.t(key, params)
  // If the key is unknown, i18next returns the key itself — fall back to
  // the raw string so users at least see something deterministic.
  return translated === key ? raw : translated
}

// Read the CSRF cookie the server sets on first hit. Not HttpOnly, so JS
// can copy it into the X-CSRF-Token header for the double-submit check.
export function readCsrfCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)impactiq_csrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]!) : null
}

async function request<T>(url: string, options?: RequestInit): Promise<ApiResponse<T>> {
  let res: Response
  const method = (options?.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options?.headers as Record<string, string> | undefined) }
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCsrfCookie()
    if (csrf) headers['X-CSRF-Token'] = csrf
  }
  try {
    res = await fetch(url, { ...options, headers })
  } catch {
    return { data: null, error: i18n.t('errors.network'), meta: {} }
  }
  let json: ApiResponse<T>
  try {
    json = await res.json() as ApiResponse<T>
  } catch {
    return { data: null, error: `HTTP ${res.status}`, meta: {} }
  }
  if (!res.ok && !json.error) {
    return { data: null, error: `HTTP ${res.status}`, meta: {} }
  }
  return { ...json, error: localizeError(json.error) }
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body), ...(headers ? { headers } : {}) }),
  patch: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  // v1.242.0: optional body. DELETE with a payload is unusual but correct
  // here — the bulk purge is scoped by ids or a week, and encoding an
  // arbitrary-length id list in a query string invites URL-length limits.
  delete: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: 'DELETE', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
}
