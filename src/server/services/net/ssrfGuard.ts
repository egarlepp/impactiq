import { promises as dns } from 'node:dns'

// Refuse any URL that isn't https + a public routable host. Blocks SSRF into
// cloud metadata endpoints (169.254.169.254), loopback, RFC1918, link-local,
// and IPv6 ULA / link-local. Resolves DNS to catch hostnames that point to
// private space. Throws with a stable message the route handlers can echo
// safely (no error-body reflection).
export async function assertPublicHttpsUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('URL is not valid')
  }
  if (url.protocol !== 'https:') throw new Error('Only https:// URLs are allowed')
  const host = url.hostname
  const ips = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address)
  for (const ip of ips) {
    if (isPrivateAddress(ip)) throw new Error('URL resolves to a non-public address')
  }
  return url
}

// Proper suffix match — host must equal the suffix or end with "." + suffix,
// never a naive .includes()/.endsWith(suffix) without the leading dot (which
// a hostname like "evil-salesforce.com.attacker.net" or "notsalesforce.com"
// would otherwise slip past).
function hasAllowedHostSuffix(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase()
  return suffixes.some((s) => {
    const suffix = s.toLowerCase()
    return h === suffix || h.endsWith(`.${suffix}`)
  })
}

const SALESFORCE_HOST_SUFFIXES = ['salesforce.com', 'force.com']

// Security fix (F-01, pentest 2026-09): assertPublicHttpsUrl alone blocks
// private/loopback/metadata destinations, but an attacker's own public HTTPS
// server still passes it — exactly the gap the report demonstrated (a
// Salesforce loginUrl pointed at a Burp Collaborator host leaked the
// Connected App client_secret during the OAuth token exchange). This adds
// the domain-specific check the report's own remediation calls for.
export async function assertSalesforceLoginUrl(rawUrl: string): Promise<URL> {
  const url = await assertPublicHttpsUrl(rawUrl)
  if (!hasAllowedHostSuffix(url.hostname, SALESFORCE_HOST_SUFFIXES)) {
    throw new Error('URL must be a salesforce.com or force.com host')
  }
  return url
}

const AZURE_OPENAI_HOST_SUFFIX = 'openai.azure.com'

// Security fix (F-02, pentest 2026-09): same rationale as
// assertSalesforceLoginUrl above. Azure OpenAI resource hostnames are
// normally *.openai.azure.com, but an org using a Private Link / custom
// domain endpoint needs an explicit, admin-configured exception rather than
// silently opening this up to any public HTTPS host — see
// the AI Assistant provider's allowedCustomHost field (ai_providers).
export async function assertAllowedAzureOpenAiEndpoint(rawUrl: string, customAllowedHost?: string | null): Promise<URL> {
  const url = await assertPublicHttpsUrl(rawUrl)
  const suffixes = [AZURE_OPENAI_HOST_SUFFIX, ...(customAllowedHost ? [customAllowedHost] : [])]
  if (!hasAllowedHostSuffix(url.hostname, suffixes)) {
    throw new Error(customAllowedHost
      ? `URL must be a ${AZURE_OPENAI_HOST_SUFFIX} host or the configured custom domain`
      : `URL must be a ${AZURE_OPENAI_HOST_SUFFIX} host (or set a custom/Private Link domain on the provider in Admin → Integrations → AI Assistant)`)
  }
  return url
}

// CriteriaIQ often runs beside ImpactIQ on the same private network (a
// Docker network or a VNet), so an App Admin can opt in to a private address
// with allowPrivateNetwork. Even then, loopback, link-local (which includes the
// 169.254.169.254 cloud metadata endpoint), unspecified and multicast
// addresses stay blocked, and plain http:// is only accepted for a private
// address, never a public one, so the API key never crosses the internet
// unencrypted. Without the opt-in this is exactly assertPublicHttpsUrl.
export async function assertCriteriaIqUrl(rawUrl: string, allowPrivateNetwork: boolean): Promise<URL> {
  return assertServiceUrl(rawUrl, allowPrivateNetwork)
}

// The same rule for any admin-configured service the app sends data to: the
// AI Assistant's webhook provider and outbound event webhooks as well as
// CriteriaIQ.
export async function assertServiceUrl(rawUrl: string, allowPrivateNetwork: boolean): Promise<URL> {
  if (!allowPrivateNetwork) return assertPublicHttpsUrl(rawUrl)
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('URL is not valid')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http:// or https:// URLs are allowed')
  const host = url.hostname
  const ips = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address)
  for (const ip of ips) {
    if (isNeverAllowedAddress(ip)) throw new Error('URL resolves to a loopback, link-local or reserved address')
    if (url.protocol === 'http:' && !isPrivateAddress(ip)) throw new Error('Only https:// is allowed for a public address')
  }
  return url
}

// An IPv4-mapped IPv6 address is judged as its IPv4 form. URL parsing writes
// [::ffff:127.0.0.1] as ::ffff:7f00:1, so both spellings are handled.
function unmapIpv4(a: string): string {
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]!
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return a
  const hi = parseInt(hex[1]!, 16)
  const lo = parseInt(hex[2]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

// Loopback, link-local (cloud metadata), unspecified and multicast/reserved.
// Never a legitimate place for another app's API.
export function isNeverAllowedAddress(addr: string): boolean {
  const a = unmapIpv4(addr.replace(/^\[|\]$/g, '').toLowerCase())
  const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [, b1, b2] = v4.map((n) => Number(n))
    return b1 === 127 || b1 === 0 || (b1 === 169 && b2 === 254) || b1! >= 224
  }
  return a === '::1' || a === '::' || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('ff')
}

// v1.477.0: an IPv4-mapped IPv6 address (https://[::ffff:127.0.0.1]/) is
// judged as its IPv4 form; it used to fall through every check as "public".
// 100.64.0.0/10 (carrier-grade NAT, also used by some cloud internal networks)
// counts as private.
export function isPrivateAddress(addr: string): boolean {
  // Bracketed IPv6 comes in without brackets from URL.hostname; be tolerant.
  const a = unmapIpv4(addr.replace(/^\[|\]$/g, '').toLowerCase())
  // IPv4
  const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [, b1, b2] = v4.map((n) => Number(n))
    if (b1 === 10) return true
    if (b1 === 100 && b2! >= 64 && b2! <= 127) return true
    if (b1 === 127) return true
    if (b1 === 0) return true
    if (b1 === 169 && b2 === 254) return true
    if (b1 === 172 && b2! >= 16 && b2! <= 31) return true
    if (b1 === 192 && b2 === 168) return true
    if (b1! >= 224) return true // multicast + reserved
    return false
  }
  // IPv6
  if (a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true
  return false
}
