import { describe, it, expect, vi } from 'vitest'
import { checkSfRecordsExist } from './referenceResolver.js'
import type jsforce from 'jsforce'

// v1.344.0: guards the one property that makes checkSfRecordsExist safe to
// use for deletion-flagging (see detectDisconnectedLinks.ts /
// activity-link-status route) — a thrown query error must propagate, never
// collapse into "not found" the way the sibling resolveSfReferences()
// deliberately does for its own (display-name) use case.
describe('checkSfRecordsExist', () => {
  function fakeConn(records: Array<{ Id: string }>): jsforce.Connection {
    return { query: vi.fn().mockResolvedValue({ records }) } as unknown as jsforce.Connection
  }

  it('returns empty map for empty ids', async () => {
    const conn = fakeConn([])
    const result = await checkSfRecordsExist(conn, 'Opportunity', [])
    expect(result.size).toBe(0)
  })

  it('marks requested-but-not-returned ids as not existing', async () => {
    const conn = fakeConn([{ Id: 'id-1' }])
    const result = await checkSfRecordsExist(conn, 'Opportunity', ['id-1', 'id-2'])
    expect(result.get('id-1')).toBe(true)
    expect(result.get('id-2')).toBe(false)
  })

  it('propagates a thrown query error rather than reporting "not found"', async () => {
    const conn = { query: vi.fn().mockRejectedValue(new Error('SF_TIMEOUT')) } as unknown as jsforce.Connection
    await expect(checkSfRecordsExist(conn, 'Opportunity', ['id-1'])).rejects.toThrow('SF_TIMEOUT')
  })
})
