import { describe, it, expect, vi } from 'vitest'

// The pure parts of the users and connection modules; nothing here touches
// the database or Gong.
vi.mock('../../db/index.js', () => ({ db: {} }))

import { pickGongUsers, toGongUserRow } from './users.js'
import { buildGongCapabilityReport, pickGongWorkspaces } from './connection.js'

describe('toGongUserRow / pickGongUsers', () => {
  it('maps a Gong user, lowercasing the email', () => {
    expect(toGongUserRow({ id: 123, emailAddress: ' Pat@Example.com ', firstName: 'Pat', lastName: 'Lee', title: 'SE', active: true }))
      .toEqual({ id: '123', email: 'pat@example.com', firstName: 'Pat', lastName: 'Lee', title: 'SE', active: true })
  })

  it('keeps deactivated users and treats a missing flag as active', () => {
    expect(toGongUserRow({ id: '9', active: false })?.active).toBe(false)
    expect(toGongUserRow({ id: '9' })?.active).toBe(true)
  })

  it('skips rows without an id and bodies without a users array', () => {
    expect(pickGongUsers({ users: [{ emailAddress: 'x@y.z' }, { id: '1' }, null] }).map((u) => u.id)).toEqual(['1'])
    expect(pickGongUsers({})).toEqual([])
  })
})

describe('pickGongWorkspaces', () => {
  it('reads id and name, falling back to the id', () => {
    expect(pickGongWorkspaces({ workspaces: [{ id: 42, name: 'Sales' }, { id: '7' }, { name: 'no id' }] }))
      .toEqual([{ id: '42', name: 'Sales' }, { id: '7', name: '7' }])
    expect(pickGongWorkspaces(null)).toEqual([])
  })
})

describe('buildGongCapabilityReport', () => {
  const now = new Date('2026-10-31T12:00:00Z')

  it('is ready when every required capability is ok, whatever workspaces says', () => {
    const r = buildGongCapabilityReport({ users: 'ok', calls: 'ok', transcripts: 'ok', workspaces: 'missing' }, now)
    expect(r.ready).toBe(true)
    expect(r.checkedAt).toBe(now.toISOString())
    expect(r.capabilities.find((c) => c.key === 'workspaces')).toMatchObject({ required: false, status: 'missing', scope: 'api:workspaces:read' })
  })

  it('is not ready when a required capability is missing or unknown', () => {
    expect(buildGongCapabilityReport({ users: 'ok', calls: 'ok', transcripts: 'missing' }, now).ready).toBe(false)
    expect(buildGongCapabilityReport({ users: 'ok', calls: 'ok' }, now).ready).toBe(false)
  })
})
