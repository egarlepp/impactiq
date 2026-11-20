import { describe, it, expect, vi, beforeEach } from 'vitest'

// The client's own logic, with the stored config and the network mocked.
const config = vi.fn()
vi.mock('./config.js', () => ({ getCriteriaIqConfig: () => config() }))
// safeFetch pins DNS through undici's own fetch and never follows a redirect;
// these tests stub the global fetch, so the mock keeps the redirect rule.
vi.mock('../net/safeFetch.js', () => ({ safeFetch: (url: string | URL, init?: RequestInit) => globalThis.fetch(url, { ...init, redirect: 'manual' }) }))
vi.mock('../net/ssrfGuard.js', () => ({ assertCriteriaIqUrl: async (raw: string) => new URL(raw) }))

import {
  CriteriaIqError, clearCriteriaIqCache, fromCriteriaIqSummary, evaluationLinkMatches, findCriteriaIqProjectsByCrmRecord,
  crmIdsEqual, findCriteriaIqProjectsForAccount, findCriteriaIqProjectsForOpportunity, getCriteriaIqProject, testCriteriaIqConnection, toCriteriaIqProject,
} from './client.js'

const BASE = 'https://criteriaiq.example.com'
const fetchMock = vi.fn()
// The summary API probe (GET /api/v1/projects/summary) is answered here, so
// fetchMock only sees the real requests. Off by default: an older CriteriaIQ
// refuses the path with a 403, and the client keeps using /api/projects.
const probe = { v1: false, calls: 0 }
const SUMMARY_PROBE_PATH = '/api/v1/projects/summary'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  clearCriteriaIqCache()
  fetchMock.mockReset()
  probe.v1 = false
  probe.calls = 0
  vi.stubGlobal('fetch', async (url: URL, init?: RequestInit) => {
    if (url.pathname === SUMMARY_PROBE_PATH && url.search === '') {
      probe.calls++
      return probe.v1
        ? jsonResponse(400, { message: 'Pass crmOpportunityId, crmAccountId or evaluationId' })
        : jsonResponse(403, { message: 'This API key does not have access to this endpoint' })
    }
    return fetchMock(url, init)
  })
  config.mockResolvedValue({ baseUrl: BASE, apiKey: 'ciq_test_key_1234567890', allowPrivateNetwork: false })
})

describe('evaluationLinkMatches', () => {
  const link = 'https://acme.lightning.force.com/lightning/r/Evaluations__c/a0X5f000001AbCdEAK/view'
  it('matches the 18- and 15-character forms of the id in the link', () => {
    expect(evaluationLinkMatches(link, 'a0X5f000001AbCdEAK')).toBe(true)
    expect(evaluationLinkMatches(link, 'a0X5f000001AbCd')).toBe(true)
  })
  it('is case-sensitive and needs a whole id', () => {
    expect(evaluationLinkMatches(link, 'A0X5F000001ABCD')).toBe(false)
    expect(evaluationLinkMatches('https://x/r/a0X5f000001AbCdEAKZZ/view', 'a0X5f000001AbCd')).toBe(false)
  })
  it('rejects ids that are not Salesforce-shaped, and empty links', () => {
    expect(evaluationLinkMatches(link, 'a0X5f.*')).toBe(false)
    expect(evaluationLinkMatches(null, 'a0X5f000001AbCd')).toBe(false)
  })
})

describe('toCriteriaIqProject', () => {
  it('maps the fields ImpactIQ uses and builds the link out', () => {
    const p = toCriteriaIqProject({
      id: 42, solutionName: 'Data Security PoC', customerName: 'Acme', status: 'active', type: 'POC',
      startDate: '2026-09-01T00:00:00.000Z', primarySe: { firstName: 'Dana', lastName: 'Lee' },
      salesforceEvaluationLink: 'https://x/a0X5f000001AbCd', engineerNotes: '',
    }, BASE)
    expect(p).toMatchObject({ id: 42, name: 'Data Security PoC', customerName: 'Acme', status: 'active', primaryEngineerName: 'Dana Lee', engineerNotes: null, url: `${BASE}/project/42` })
  })
  it('counts active success criteria and the ones met', () => {
    const p = toCriteriaIqProject({
      id: 5, name: 'P', successCriteria: [
        { status: 'Met' }, { status: 'passed', isActive: true }, { status: 'pending' }, { status: 'met', isActive: false }, null,
      ],
    }, BASE)
    expect(p).toMatchObject({ criteriaTotal: 3, criteriaMet: 2 })
    expect(toCriteriaIqProject({ id: 6, name: 'Q' }, BASE)).toMatchObject({ criteriaTotal: null, criteriaMet: null })
  })
  it('returns null for something that is not a project', () => {
    expect(toCriteriaIqProject({ message: 'nope' }, BASE)).toBeNull()
    expect(toCriteriaIqProject(null, BASE)).toBeNull()
  })
})

describe('testCriteriaIqConnection', () => {
  it('passes on CriteriaIQ\'s JSON 404 for project 0, sending the key as a Bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'Project not found' }))
    await expect(testCriteriaIqConnection()).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`${BASE}/api/projects/0`)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer ciq_test_key_1234567890' })
    expect((init as RequestInit).redirect).toBe('manual')
  })
  it('maps 401, 403, a non-CriteriaIQ 404 and a network failure to error codes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Invalid or revoked API key' }))
    await expect(testCriteriaIqConnection()).rejects.toMatchObject({ code: 'errors.criteriaiq.unauthorized' })
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: 'scope' }))
    await expect(testCriteriaIqConnection()).rejects.toMatchObject({ code: 'errors.criteriaiq.forbidden' })
    fetchMock.mockResolvedValueOnce(new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }))
    await expect(testCriteriaIqConnection()).rejects.toMatchObject({ code: 'errors.criteriaiq.bad_response' })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(testCriteriaIqConnection()).rejects.toMatchObject({ code: 'errors.criteriaiq.unreachable' })
  })
  it('throws not_configured without a connection', async () => {
    config.mockResolvedValue(null)
    await expect(testCriteriaIqConnection()).rejects.toBeInstanceOf(CriteriaIqError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getCriteriaIqProject', () => {
  it('returns null for a missing project and the mapped project otherwise', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'Project not found' }))
    expect(await getCriteriaIqProject(7)).toBeNull()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 7, name: 'Eval', customerName: 'Acme' }))
    expect(await getCriteriaIqProject(7)).toMatchObject({ id: 7, name: 'Eval' })
  })
})

describe('findCriteriaIqProjectsByCrmRecord', () => {
  it('filters the project list by Evaluation link and caches the list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [
      { id: 1, name: 'One', customerName: 'A', salesforceEvaluationLink: 'https://x/r/Evaluations__c/a0X5f000001AbCdEAK/view' },
      { id: 2, name: 'Two', customerName: 'B', salesforceEvaluationLink: 'https://x/r/Evaluations__c/a0X5f000009ZzZzEAK/view' },
    ]))
    expect((await findCriteriaIqProjectsByCrmRecord('a0X5f000001AbCdEAK')).map((p) => p.id)).toEqual([1])
    expect((await findCriteriaIqProjectsByCrmRecord('a0X5f000009ZzZz')).map((p) => p.id)).toEqual([2])
    expect(await findCriteriaIqProjectsByCrmRecord('a0X5f000005NoNo')).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('treats a non-list answer as a bad response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { message: 'x' }))
    await expect(findCriteriaIqProjectsByCrmRecord('a0X5f000001AbCd')).rejects.toMatchObject({ code: 'errors.criteriaiq.bad_response' })
  })
})

describe('crmIdsEqual', () => {
  it('compares Salesforce ids in 15- or 18-character form and HubSpot ids exactly', () => {
    expect(crmIdsEqual('006A0000004kzLqIAI', '006A0000004kzLq')).toBe(true)
    expect(crmIdsEqual('006A0000004kzLq', '006a0000004kzLq')).toBe(false)
    expect(crmIdsEqual('356553095874', '356553095874')).toBe(true)
    expect(crmIdsEqual('123456789012345678', '123456789012345')).toBe(false)
    expect(crmIdsEqual(null, '356553095874')).toBe(false)
  })
})

describe('findCriteriaIqProjectsForOpportunity', () => {
  it('uses CriteriaIQ\'s crmOpportunityId filter and checks each returned row', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [
      { id: 1, name: 'One', opportunityName: 'Acme', crmProvider: 'salesforce', crmOpportunityId: '006A0000004kzLqIAI', crmAccountId: '001A0000001AbCd' },
      { id: 2, name: 'Two', opportunityName: 'Acme', crmProvider: 'salesforce', crmOpportunityId: '006A0000009ZzZz', crmAccountId: null },
    ]))
    const r = await findCriteriaIqProjectsForOpportunity({ id: '006A0000004kzLq', name: 'Acme' })
    expect(r).toMatchObject({ matchedBy: 'id' })
    expect(r.projects.map((p) => p.id)).toEqual([1])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/projects?crmOpportunityId=006A0000004kzLq`)
  })

  it('falls back to the name, skipping projects tied to a different Opportunity', async () => {
    fetchMock.mockImplementation(async (url: URL) => jsonResponse(200, url.search
      ? []
      : [
          { id: 1, name: 'One', opportunityName: 'Acme Renewal', crmOpportunityId: null },
          { id: 2, name: 'Two', opportunityName: 'acme renewal', crmOpportunityId: '006A0000009ZzZz' },
          { id: 3, name: 'Three', opportunityName: 'Acme Renewal FY27', crmOpportunityId: null },
        ]))
    const r = await findCriteriaIqProjectsForOpportunity({ id: '006A0000004kzLq', name: '  acme renewal ' })
    expect(r).toMatchObject({ matchedBy: 'name' })
    expect(r.projects.map((p) => p.id)).toEqual([1])
    expect((await findCriteriaIqProjectsForOpportunity({ id: null, name: '   ' })).projects).toEqual([])
  })

  it('matches by name on a CriteriaIQ without CRM ids, and stops sending the filter once it knows', async () => {
    // An older CriteriaIQ ignores the filter and returns every project.
    fetchMock.mockImplementation(async () => jsonResponse(200, [
      { id: 1, name: 'One', opportunityName: 'Acme Renewal' },
      { id: 2, name: 'Two', opportunityName: 'Other' },
    ]))
    const r = await findCriteriaIqProjectsForOpportunity({ id: '006A0000004kzLq', name: 'Acme Renewal' })
    expect(r).toMatchObject({ matchedBy: 'name' })
    expect(r.projects.map((p) => p.id)).toEqual([1])
    const calls = fetchMock.mock.calls.length
    await findCriteriaIqProjectsForOpportunity({ id: '006A0000005NoNo', name: 'Other' })
    expect(fetchMock.mock.calls.length).toBe(calls)
  })
})

describe('findCriteriaIqProjectsForAccount', () => {
  it('returns projects whose crmAccountId matches', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [
      { id: 4, name: 'Four', crmAccountId: '247756533' },
      { id: 5, name: 'Five', crmAccountId: '999' },
    ]))
    expect((await findCriteriaIqProjectsForAccount('247756533')).map((p) => p.id)).toEqual([4])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/projects?crmAccountId=247756533`)
  })
})

function summary(id: number, overrides: Record<string, unknown> = {}) {
  return {
    version: 1, id, name: `Project ${id}`, customerName: 'Acme', solutionName: 'Data Security', opportunityName: 'Acme FY27',
    type: 'POC', status: 'active', customerStatus: 'On Time', startDate: '2026-09-01T00:00:00.000Z', endDate: null,
    completedDate: null, updatedAt: '2026-10-20T12:00:00.000Z',
    crm: { provider: 'salesforce', opportunityId: '006A0000004kzLqIAI', accountId: '001A0000006Vm9rIAC', evaluationLink: null },
    criteria: { total: 10, met: 6, failed: 1, open: 1, excluded: 2 },
    map: { phases: { total: 3, completed: 1 }, tasks: { total: 20, completed: 12 } },
    team: [
      { role: 'supporting_engineer', userId: 'u2', name: 'Sam Roe', email: 'sam@example.com' },
      { role: 'primary_engineer', userId: 'u1', name: 'Dana Lee', email: 'dana@example.com' },
    ],
    url: 'https://somewhere-else.example.com/project/' + id,
    ...overrides,
  }
}

describe('fromCriteriaIqSummary', () => {
  it('maps a v1 summary, leaving excluded criteria out of the total', () => {
    expect(fromCriteriaIqSummary(summary(42), BASE)).toEqual({
      id: 42, name: 'Project 42', customerName: 'Acme', opportunityName: 'Acme FY27', status: 'active', type: 'POC',
      startDate: '2026-09-01T00:00:00.000Z', endDate: null, primaryEngineerName: 'Dana Lee', engineerNotes: null,
      evaluationLink: null, crmOpportunityId: '006A0000004kzLqIAI', crmAccountId: '001A0000006Vm9rIAC', hasCrmIds: true,
      criteriaTotal: 8, criteriaMet: 6, mapTasksTotal: 20, mapTasksCompleted: 12,
      // Built from the configured URL, not the one in the response.
      url: `${BASE}/project/42`,
    })
  })
  it('tolerates missing blocks and rejects what is not a project', () => {
    expect(fromCriteriaIqSummary({ id: 3, name: 'X' }, BASE)).toMatchObject({
      criteriaTotal: null, criteriaMet: null, mapTasksTotal: null, primaryEngineerName: null,
    })
    expect(fromCriteriaIqSummary({ id: '3' }, BASE)).toBeNull()
    expect(fromCriteriaIqSummary(null, BASE)).toBeNull()
  })
})

describe('toCriteriaIqProject (older CriteriaIQ)', () => {
  it('counts CriteriaIQ\'s "complete" status as met', () => {
    expect(toCriteriaIqProject({ id: 1, name: 'P', successCriteria: [{ status: 'complete' }, { status: 'in_progress' }] }, BASE))
      .toMatchObject({ criteriaTotal: 2, criteriaMet: 1, mapTasksTotal: null })
  })
})

describe('summary API', () => {
  beforeEach(() => { probe.v1 = true })

  it('reads one project from /api/v1 and probes support once', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { data: summary(7) }))
    expect(await getCriteriaIqProject(7)).toMatchObject({ id: 7, criteriaMet: 6, mapTasksCompleted: 12 })
    expect(await getCriteriaIqProject(7)).toMatchObject({ id: 7 })
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/v1/projects/7/summary`)
    expect(probe.calls).toBe(1)
  })

  it('returns null for a missing project', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(404, { message: 'Project not found' }))
    expect(await getCriteriaIqProject(9)).toBeNull()
  })

  it('looks Opportunities and Accounts up through the summary lookup', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { data: [summary(1), summary(2, { crm: { opportunityId: '006A0000009ZzZzEAK', accountId: '001A0000006Vm9rIAC' } })] }))
    const r = await findCriteriaIqProjectsForOpportunity({ id: '006A0000004kzLq', name: 'Acme FY27' })
    expect(r).toMatchObject({ matchedBy: 'id' })
    expect(r.projects.map((p) => p.id)).toEqual([1])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/v1/projects/summary?crmOpportunityId=006A0000004kzLq`)

    fetchMock.mockClear()
    expect((await findCriteriaIqProjectsForAccount('001A0000006Vm9r')).map((p) => p.id)).toEqual([1, 2])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/v1/projects/summary?crmAccountId=001A0000006Vm9r`)
  })

  it('treats CriteriaIQ\'s 400 for an id it can\'t parse as no match', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(400, { message: 'Invalid crmAccountId' }))
    expect(await findCriteriaIqProjectsForAccount('not an id')).toEqual([])
  })

  it('finds Evaluation links with ?evaluationId= and re-checks each link', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { data: [
      summary(1, { crm: { evaluationLink: 'https://x/r/Evaluations__c/a0X5f000001AbCdEAK/view' } }),
      summary(2, { crm: { evaluationLink: 'https://x/r/Evaluations__c/a0X5f000001AbCdEAKZZ/view' } }),
    ] }))
    expect((await findCriteriaIqProjectsByCrmRecord('a0X5f000001AbCdEAK')).map((p) => p.id)).toEqual([1])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/v1/projects/summary?evaluationId=a0X5f000001AbCdEAK`)
    expect(await findCriteriaIqProjectsByCrmRecord('not-an-id')).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws bad_response on an unexpected lookup answer', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, [summary(1)]))
    await expect(findCriteriaIqProjectsForAccount('001A0000006Vm9r')).rejects.toMatchObject({ code: 'errors.criteriaiq.bad_response' })
  })
})

describe('summary API probe', () => {
  it('falls back to /api/projects when CriteriaIQ refuses the path, without reporting an error', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { id: 7, name: 'Eval' }))
    expect(await getCriteriaIqProject(7)).toMatchObject({ id: 7, mapTasksTotal: null })
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/projects/7`)
  })
})
