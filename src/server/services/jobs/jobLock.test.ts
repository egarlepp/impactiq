import { describe, it, expect, beforeEach } from 'vitest'
import { withJobLock } from './jobLock.js'

// The cross-process half (a second replica sees the lock held) needs a real
// Postgres and is checked by hand; these cover the parts that don't.
describe('withJobLock without a database', () => {
  beforeEach(() => {
    delete process.env['DATABASE_URL']
  })

  it('runs the task when no database is configured', async () => {
    let ran = false
    const result = await withJobLock('test_job', async () => { ran = true })
    expect(result).toEqual({ ran: true })
    expect(ran).toBe(true)
  })

  it('skips a second run of the same job in the same process', async () => {
    let release: () => void = () => {}
    const first = withJobLock('test_job', () => new Promise<void>((r) => { release = r }))
    const second = await withJobLock('test_job', async () => { throw new Error('should not run') })
    expect(second).toEqual({ ran: false, reason: 'locked' })
    release()
    expect(await first).toEqual({ ran: true })
    // Released afterwards, so the next run goes ahead.
    expect(await withJobLock('test_job', async () => {})).toEqual({ ran: true })
  })

  it('does not block a different job', async () => {
    let release: () => void = () => {}
    const first = withJobLock('job_a', () => new Promise<void>((r) => { release = r }))
    expect(await withJobLock('job_b', async () => {})).toEqual({ ran: true })
    release()
    await first
  })

  it('releases the job when the task throws', async () => {
    await expect(withJobLock('test_job', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await withJobLock('test_job', async () => {})).toEqual({ ran: true })
  })
})
