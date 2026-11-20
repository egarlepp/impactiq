import { describe, it, expect, vi } from 'vitest'

// v1.443.0: jobs wait for the server's migration run before their first tick.
vi.mock('../../db/index.js', () => ({ db: {} }))
vi.mock('../crm/providerSetting.js', () => ({ getCrmProviderId: async () => 'salesforce' }))
vi.mock('./jobReadiness.js', () => ({ jobWaitingFor: async () => null }))

const { scheduleJob, holdJobsUntil } = await import('./scheduler.js')

const flush = () => new Promise((r) => setTimeout(r, 20))

describe('holdJobsUntil', () => {
  it('holds a boot-time job until the migrations settle', async () => {
    let settle: () => void = () => {}
    holdJobsUntil(new Promise<void>((r) => { settle = r }))
    let runs = 0
    const stop = scheduleJob('sync_audit_cull', 60 * 60 * 1000, async () => { runs++ }, { firstRunDelayMs: 0 })
    await flush()
    expect(runs).toBe(0)
    settle()
    await flush()
    expect(runs).toBe(1)
    stop()
  })

  it('releases the jobs when the migrations fail', async () => {
    let fail: (err: Error) => void = () => {}
    holdJobsUntil(new Promise<void>((_r, reject) => { fail = reject }))
    let runs = 0
    const stop = scheduleJob('sync_audit_cull', 60 * 60 * 1000, async () => { runs++ }, { firstRunDelayMs: 0 })
    fail(new Error('database unreachable'))
    await flush()
    expect(runs).toBe(1)
    stop()
  })
})
