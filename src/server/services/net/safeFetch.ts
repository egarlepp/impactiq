// v1.477.0: fetch for any URL an admin configures (or a remote server hands
// back, such as an OIDC discovery document). assertPublicHttpsUrl /
// assertServiceUrl check the address a hostname resolves to, but a plain
// fetch() then resolves it again, so a DNS answer that changes between the two
// (DNS rebinding) could still reach a private address, and fetch() follows
// redirects to anywhere by default. safeFetch closes both gaps:
//   1. the URL is checked up front (scheme, IP literals, first resolution);
//   2. the connection itself goes through a lookup that re-checks every
//      address it is about to connect to, so the address that was checked is
//      the address that is used;
//   3. redirects are never followed (redirect: 'manual'): a 3xx comes back as
//      the response, and callers already treat anything but 2xx as a failure.
//
// It uses undici's own fetch, because Node's bundled fetch can't take a
// dispatcher from the undici package (their handler APIs differ). The result
// is typed as the global Response, which it matches for every use here
// (status, ok, headers, json(), text()).
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { assertPublicHttpsUrl, assertServiceUrl, isNeverAllowedAddress, isPrivateAddress } from './ssrfGuard.js'

export interface SafeFetchOptions {
  // Allow a private-network address (CriteriaIQ, an AI or event webhook on
  // the same Docker network or VNet). Loopback, link-local (cloud metadata),
  // unspecified and multicast addresses stay blocked, and plain http:// is
  // only allowed to a private address. Default: public https only.
  allowPrivateNetwork?: boolean
}

export type SafeFetchInit = Omit<RequestInit, 'redirect'>

type AddressPolicy = (address: string) => boolean

const BLOCKED_MESSAGE = 'URL resolves to a non-public address'

export class SsrfBlockedError extends Error {
  readonly code = 'ESSRFBLOCKED'
  constructor(message = BLOCKED_MESSAGE) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

// A net.connect lookup that refuses to hand back an address the policy
// rejects. Node calls it with or without `all`, so both answer shapes are
// supported.
export function guardedLookup(allowed: AddressPolicy) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) { callback(err, []); return }
      const list = addresses as LookupAddress[]
      if (list.length === 0) { callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []); return }
      if (list.some((a) => !allowed(a.address))) { callback(new SsrfBlockedError(), []); return }
      if (options.all) { callback(null, list); return }
      const first = list[0]!
      callback(null, first.address, first.family)
    })
  }
}

const publicOnly: AddressPolicy = (ip) => !isPrivateAddress(ip)
const privateHttps: AddressPolicy = (ip) => !isNeverAllowedAddress(ip)
const privateHttp: AddressPolicy = (ip) => isPrivateAddress(ip) && !isNeverAllowedAddress(ip)

let agents: { public: Agent; privateHttps: Agent; privateHttp: Agent } | null = null

function agentFor(protocol: string, allowPrivateNetwork: boolean): Agent {
  agents ??= {
    public: new Agent({ connect: { lookup: guardedLookup(publicOnly) } }),
    privateHttps: new Agent({ connect: { lookup: guardedLookup(privateHttps) } }),
    privateHttp: new Agent({ connect: { lookup: guardedLookup(privateHttp) } }),
  }
  if (!allowPrivateNetwork) return agents.public
  return protocol === 'http:' ? agents.privateHttp : agents.privateHttps
}

export async function safeFetch(rawUrl: string | URL, init: SafeFetchInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  const allowPrivateNetwork = opts.allowPrivateNetwork === true
  const href = typeof rawUrl === 'string' ? rawUrl : rawUrl.href
  const url = allowPrivateNetwork ? await assertServiceUrl(href, true) : await assertPublicHttpsUrl(href)
  const res = await undiciFetch(url.href, {
    ...(init as UndiciRequestInit),
    redirect: 'manual',
    dispatcher: agentFor(url.protocol, allowPrivateNetwork),
  })
  return res as unknown as Response
}
