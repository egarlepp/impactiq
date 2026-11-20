// Regression tests for the SSRF guard (F-01/F-02, pentest 2026-09).
// `node:dns` is mocked so these tests are hermetic — no real DNS/network
// access needed, and each hostname's "resolved" address is fully
// controllable per test (including simulating DNS rebinding, where a
// public-looking hostname resolves to a private address).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const lookupMock = vi.fn()
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}))

import { assertPublicHttpsUrl, assertSalesforceLoginUrl, assertAllowedAzureOpenAiEndpoint, assertCriteriaIqUrl } from './ssrfGuard.js'

beforeEach(() => {
  lookupMock.mockReset()
  // Default: any hostname "resolves" to a plainly public address unless a
  // test overrides it — keeps every test that isn't specifically about DNS
  // resolution from having to stub this itself.
  lookupMock.mockResolvedValue([{ address: '203.0.113.10', family: 4 }])
})

describe('assertPublicHttpsUrl', () => {
  it('accepts a public https URL', async () => {
    const url = await assertPublicHttpsUrl('https://example.com/path')
    expect(url.hostname).toBe('example.com')
  })

  it('rejects a non-https URL', async () => {
    await expect(assertPublicHttpsUrl('http://example.com')).rejects.toThrow(/https/i)
  })

  it('rejects a malformed URL', async () => {
    await expect(assertPublicHttpsUrl('not a url')).rejects.toThrow()
  })

  it('rejects loopback, RFC1918, and cloud-metadata literal IPs with no DNS lookup needed', async () => {
    await expect(assertPublicHttpsUrl('https://127.0.0.1/x')).rejects.toThrow(/non-public/i)
    await expect(assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/non-public/i)
    await expect(assertPublicHttpsUrl('https://10.1.2.3/')).rejects.toThrow(/non-public/i)
    await expect(assertPublicHttpsUrl('https://172.20.0.1/')).rejects.toThrow(/non-public/i)
    await expect(assertPublicHttpsUrl('https://192.168.1.1/')).rejects.toThrow(/non-public/i)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('rejects a hostname that DNS-resolves to a private address (rebinding)', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])
    await expect(assertPublicHttpsUrl('https://attacker.example/')).rejects.toThrow(/non-public/i)
  })

  it('accepts a hostname that resolves to a public address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    await expect(assertPublicHttpsUrl('https://example.com/')).resolves.toBeInstanceOf(URL)
  })
})

describe('assertSalesforceLoginUrl (F-01)', () => {
  it('accepts a real salesforce.com / force.com subdomain', async () => {
    await expect(assertSalesforceLoginUrl('https://mycompany.my.salesforce.com')).resolves.toBeInstanceOf(URL)
    await expect(assertSalesforceLoginUrl('https://mycompany.force.com')).resolves.toBeInstanceOf(URL)
    await expect(assertSalesforceLoginUrl('https://login.salesforce.com')).resolves.toBeInstanceOf(URL)
  })

  it('rejects an attacker-controlled public HTTPS host — the exact F-01 exploit', async () => {
    // The report's own reproduction: a public HTTPS Collaborator-style host
    // that passes a generic "is it public HTTPS" check but isn't Salesforce.
    await expect(assertSalesforceLoginUrl('https://abc123.oastify.com')).rejects.toThrow(/salesforce\.com or force\.com/)
  })

  it('rejects lookalike hosts that merely contain "salesforce.com" as a substring', async () => {
    await expect(assertSalesforceLoginUrl('https://salesforce.com.attacker.net')).rejects.toThrow()
    await expect(assertSalesforceLoginUrl('https://notsalesforce.com')).rejects.toThrow()
    await expect(assertSalesforceLoginUrl('https://evil-salesforce.com')).rejects.toThrow()
  })
})

describe('assertAllowedAzureOpenAiEndpoint (F-02)', () => {
  it('accepts a standard *.openai.azure.com host', async () => {
    await expect(assertAllowedAzureOpenAiEndpoint('https://acme-openai-prod.openai.azure.com/')).resolves.toBeInstanceOf(URL)
  })

  it('rejects an attacker-controlled host with no custom allowlist configured — the exact F-02 exploit', async () => {
    await expect(assertAllowedAzureOpenAiEndpoint('https://abc123.oastify.com', null)).rejects.toThrow(/openai\.azure\.com/)
  })

  it('rejects a non-matching host even when a DIFFERENT custom host is configured', async () => {
    await expect(assertAllowedAzureOpenAiEndpoint('https://attacker.example', 'my-resource.privatelink.openai.azure.com')).rejects.toThrow()
  })

  it('accepts the exact admin-configured custom host', async () => {
    await expect(assertAllowedAzureOpenAiEndpoint('https://my-resource.privatelink.openai.azure.com', 'my-resource.privatelink.openai.azure.com')).resolves.toBeInstanceOf(URL)
  })
})

describe('assertCriteriaIqUrl', () => {
  it('without the private-network opt-in behaves like assertPublicHttpsUrl', async () => {
    await expect(assertCriteriaIqUrl('https://criteriaiq.example.com', false)).resolves.toBeInstanceOf(URL)
    await expect(assertCriteriaIqUrl('https://10.0.0.5', false)).rejects.toThrow(/non-public/i)
    await expect(assertCriteriaIqUrl('http://criteriaiq.example.com', false)).rejects.toThrow(/https/i)
  })

  it('with the opt-in accepts a private address, over http or https', async () => {
    lookupMock.mockResolvedValue([{ address: '172.18.0.4', family: 4 }])
    await expect(assertCriteriaIqUrl('http://criteriaiq:5000', true)).resolves.toBeInstanceOf(URL)
    await expect(assertCriteriaIqUrl('https://10.0.0.5', true)).resolves.toBeInstanceOf(URL)
  })

  it('with the opt-in still refuses plain http to a public address', async () => {
    await expect(assertCriteriaIqUrl('http://criteriaiq.example.com', true)).rejects.toThrow(/https/i)
    await expect(assertCriteriaIqUrl('https://criteriaiq.example.com', true)).resolves.toBeInstanceOf(URL)
  })

  it('with the opt-in still refuses loopback, cloud metadata and IPv4-mapped loopback', async () => {
    await expect(assertCriteriaIqUrl('http://127.0.0.1:5000', true)).rejects.toThrow(/loopback/i)
    await expect(assertCriteriaIqUrl('http://169.254.169.254/latest/meta-data', true)).rejects.toThrow(/loopback/i)
    await expect(assertCriteriaIqUrl('http://[::ffff:127.0.0.1]/', true)).rejects.toThrow(/loopback/i)
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(assertCriteriaIqUrl('http://localhost:5000', true)).rejects.toThrow(/loopback/i)
  })

  it('refuses non-http schemes', async () => {
    await expect(assertCriteriaIqUrl('ftp://10.0.0.5', true)).rejects.toThrow(/http/i)
  })
})
