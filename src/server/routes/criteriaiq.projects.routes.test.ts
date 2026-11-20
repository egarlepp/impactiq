// GET /api/criteriaiq/projects (v1.409.0): the CriteriaIQ Project picker's
// suggestions, by the CRM ids CriteriaIQ stores on its projects, with the
// Opportunity name as fallback. The CriteriaIQ API is mocked at fetch.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
// safeFetch pins DNS through undici's own fetch and never follows a redirect;
// these tests stub the global fetch, so the mock keeps the redirect rule.
vi.mock('../services/net/safeFetch.js', () => ({ safeFetch: (url: string | URL, init?: RequestInit) => globalThis.fetch(url, { ...init, redirect: 'manual' }) }))


vi.mock('../services/criteriaiq/config.js', () => ({
  getCriteriaIqConfig: async () => ({ baseUrl: 'https://ciq.example.com', apiKey: 'ciq_test_key_1234567890', allowPrivateNetwork: false }),
}))
vi.mock('../services/net/ssrfGuard.js', () => ({ assertCriteriaIqUrl: async (raw: string) => new URL(raw) }))
let primary = 'criteriaiq'
vi.mock('../services/criteriaiq/evaluationSource.js', async () => {
  const actual = await vi.importActual<typeof import('../services/criteriaiq/evaluationSource.js')>('../services/criteriaiq/evaluationSource.js')
  return { ...actual, getEvaluationSourceSetting: async () => ({ primary, dataSource: primary, criteriaiqSecondary: false }) }
})

const PROJECTS = [
  { id: 1, name: 'POC', opportunityName: 'Acme Renewal', crmProvider: 'hubspot', crmOpportunityId: '356553095874', crmAccountId: '1001' },
  { id: 2, name: 'POV', opportunityName: 'Acme Expansion', crmProvider: 'hubspot', crmOpportunityId: '356553095999', crmAccountId: '1001' },
  { id: 3, name: 'Old', opportunityName: 'Beta Deal', crmProvider: null, crmOpportunityId: null, crmAccountId: null },
]

const fetchMock = vi.fn(async (url: URL) => {
  const opp = url.searchParams.get('crmOpportunityId')
  const acct = url.searchParams.get('crmAccountId')
  const rows = opp ? PROJECTS.filter((p) => p.crmOpportunityId === opp)
    : acct ? PROJECTS.filter((p) => p.crmAccountId === acct)
    : PROJECTS
  return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
})

let criteriaiqRouter: typeof import('./criteriaiq.js')['criteriaiqRouter']
let clearCriteriaIqCache: () => void

beforeAll(async () => {
  criteriaiqRouter = (await import('./criteriaiq.js')).criteriaiqRouter
  clearCriteriaIqCache = (await import('../services/criteriaiq/client.js')).clearCriteriaIqCache
})

const realFetch = globalThis.fetch

beforeEach(() => {
  primary = 'criteriaiq'
  clearCriteriaIqCache()
  fetchMock.mockClear()
  // CriteriaIQ's requests go to the mock, the test's own request to the app
  // goes out for real.
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    return url.hostname === 'ciq.example.com' ? fetchMock(url) : realFetch(input, init)
  })
})

async function get(path: string) {
  const app = express()
  app.use('/api/criteriaiq', criteriaiqRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> | null; error: string | null } }
  } finally {
    server.close()
  }
}

function ids(v: unknown): number[] {
  return (v as Array<{ id: number }>).map((p) => p.id)
}

describe('GET /api/criteriaiq/projects', () => {
  it('suggests projects on the Deal by id and other projects on its Company', async () => {
    const { status, body } = await get('/api/criteriaiq/projects?oppId=356553095874&oppName=Acme%20Renewal&accountId=1001')
    expect(status).toBe(200)
    expect(ids(body.data!['suggested'])).toEqual([1])
    expect(body.data!['matchedBy']).toBe('id')
    expect(ids(body.data!['accountSuggested'])).toEqual([2])
  })

  it('falls back to the Opportunity name when no project holds its id', async () => {
    const { body } = await get('/api/criteriaiq/projects?oppId=356553000000&oppName=beta%20deal')
    expect(ids(body.data!['suggested'])).toEqual([3])
    expect(body.data!['matchedBy']).toBe('name')
  })

  it('refuses a malformed Opportunity id', async () => {
    const { status, body } = await get('/api/criteriaiq/projects?oppId=bad%20id')
    expect(status).toBe(400)
    expect(body.error).toBe('errors.criteriaiq.invalid_request')
  })

  it('answers 409 unless CriteriaIQ is the primary source', async () => {
    primary = 'crm'
    const { status } = await get('/api/criteriaiq/projects?oppId=356553095874')
    expect(status).toBe(409)
  })
})
