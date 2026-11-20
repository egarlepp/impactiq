// v1.477.0: safeFetch checks the URL up front, re-checks every address at
// connect time (the DNS-rebinding gap), and never follows a redirect.
// node:dns and undici are mocked, so nothing here touches the network.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Addr = { address: string; family: number }
let answer: Addr[] = []
vi.mock('node:dns', () => ({
  promises: { lookup: async () => answer },
  lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: Addr[]) => void) => cb(null, answer),
}))

const undiciFetch = vi.fn()
vi.mock('undici', () => ({
  Agent: class { constructor(public opts: unknown) {} },
  fetch: (...args: unknown[]) => undiciFetch(...args),
}))

import { guardedLookup, safeFetch, SsrfBlockedError } from './safeFetch.js'
import { isPrivateAddress } from './ssrfGuard.js'

function runLookup(policy: (ip: string) => boolean, all: boolean): Promise<{ err: Error | null; address: unknown; family: number | undefined }> {
  return new Promise((resolve) => {
    guardedLookup(policy)('host.example', { all }, (err, address, family) => resolve({ err, address, family }))
  })
}

beforeEach(() => {
  answer = [{ address: '203.0.113.10', family: 4 }]
  undiciFetch.mockReset()
  undiciFetch.mockResolvedValue(new Response('ok', { status: 200 }))
})

describe('guardedLookup', () => {
  const publicOnly = (ip: string) => !isPrivateAddress(ip)

  it('hands back an allowed address in both answer shapes', async () => {
    expect(await runLookup(publicOnly, false)).toEqual({ err: null, address: '203.0.113.10', family: 4 })
    expect(await runLookup(publicOnly, true)).toEqual({ err: null, address: answer, family: undefined })
  })

  it('refuses when the connect-time answer is private (DNS rebinding)', async () => {
    answer = [{ address: '203.0.113.10', family: 4 }, { address: '169.254.169.254', family: 4 }]
    const r = await runLookup(publicOnly, false)
    expect(r.err).toBeInstanceOf(SsrfBlockedError)
  })
})

describe('safeFetch', () => {
  it('never follows a redirect and always passes a dispatcher', async () => {
    await safeFetch('https://hooks.example.com/x', { method: 'POST', body: '{}' })
    const [url, init] = undiciFetch.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('https://hooks.example.com/x')
    expect(init['redirect']).toBe('manual')
    expect(init['method']).toBe('POST')
    expect(init['dispatcher']).toBeDefined()
  })

  it('refuses a private or IPv4-mapped literal before connecting', async () => {
    await expect(safeFetch('https://10.0.0.5/')).rejects.toThrow(/non-public/)
    await expect(safeFetch('https://[::ffff:127.0.0.1]/')).rejects.toThrow(/non-public/)
    await expect(safeFetch('http://example.com/')).rejects.toThrow(/https/)
    expect(undiciFetch).not.toHaveBeenCalled()
  })

  it('allows a private https address only with the opt-in, and never loopback', async () => {
    answer = [{ address: '10.0.0.5', family: 4 }]
    await expect(safeFetch('https://criteriaiq.internal/')).rejects.toThrow(/non-public/)
    await expect(safeFetch('https://criteriaiq.internal/', {}, { allowPrivateNetwork: true })).resolves.toBeDefined()
    await expect(safeFetch('http://127.0.0.1:8080/', {}, { allowPrivateNetwork: true })).rejects.toThrow(/loopback/)
  })
})

describe('isPrivateAddress additions', () => {
  it('treats IPv4-mapped IPv6 and carrier-grade NAT as private', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true)
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true)
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('100.128.0.1')).toBe(false)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })
})
