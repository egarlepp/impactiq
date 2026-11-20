import { describe, it, expect } from 'vitest'
import type { ErrorEvent } from '@sentry/node'
import { scrubEvent, isErrorTrackingEnabled, reportError } from './errorTracking.js'

describe('scrubEvent', () => {
  it('drops bodies, cookies, query strings and auth headers', () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: 'https://iq.example.com/api/activities?token=abc',
        query_string: 'token=abc',
        data: { notes: 'private' },
        cookies: { sid: 'secret' },
        headers: { Authorization: 'Bearer x', cookie: 'sid=secret', 'user-agent': 'UA', 'X-CSRF-Token': 'c' },
      },
      user: { id: 'u1', email: 'a@b.c', ip_address: '1.2.3.4' },
    }
    const out = scrubEvent(event)
    expect(out.request?.url).toBe('https://iq.example.com/api/activities')
    expect(out.request?.query_string).toBeUndefined()
    expect(out.request?.data).toBeUndefined()
    expect(out.request?.cookies).toBeUndefined()
    expect(out.request?.headers).toEqual({ 'user-agent': 'UA' })
    expect(out.user).toEqual({ id: 'u1' })
  })

  it('removes a user with no id', () => {
    const out = scrubEvent({ type: undefined, user: { email: 'a@b.c' } })
    expect(out.user).toBeUndefined()
  })
})

describe('error tracking when SENTRY_DSN is unset', () => {
  it('stays off and reporting is a no-op', () => {
    expect(isErrorTrackingEnabled()).toBe(false)
    expect(() => reportError(new Error('x'))).not.toThrow()
  })
})
