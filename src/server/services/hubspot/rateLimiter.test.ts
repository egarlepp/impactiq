import { describe, it, expect } from 'vitest'
import { SlidingWindowLimiter, applyRateLimitHeaders } from './rateLimiter.js'

// A fake clock: sleep() advances time instead of waiting.
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    advance: (ms: number) => { t += ms },
    sleeps,
  }
}

describe('SlidingWindowLimiter', () => {
  it('lets `max` requests through at once, then waits for the oldest to age out', async () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 3, intervalMs: 1000 }, clock.now, clock.sleep)
    await limiter.acquire(); await limiter.acquire(); await limiter.acquire()
    expect(clock.sleeps).toEqual([])
    await limiter.acquire()
    expect(clock.sleeps).toEqual([1000])
    expect(clock.now()).toBe(1000)
  })

  it('serves callers in arrival order', async () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 1, intervalMs: 100 }, clock.now, clock.sleep)
    const order: number[] = []
    await Promise.all([1, 2, 3].map((n) => limiter.acquire().then(() => order.push(n))))
    expect(order).toEqual([1, 2, 3])
    expect(clock.now()).toBe(200)
  })

  it('pause() holds every caller until the pause ends', async () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 5, intervalMs: 1000 }, clock.now, clock.sleep)
    limiter.pause(250)
    await limiter.acquire()
    expect(clock.now()).toBe(250)
  })

  it('ignores impossible limits', () => {
    const limiter = new SlidingWindowLimiter({ max: 5, intervalMs: 1000 })
    limiter.setLimits({ max: 0, intervalMs: 1000 })
    expect(limiter.limits).toEqual({ max: 5, intervalMs: 1000 })
  })
})

describe('applyRateLimitHeaders', () => {
  it("follows HubSpot's reported burst limit with a 10% margin", () => {
    const limiter = new SlidingWindowLimiter({ max: 90, intervalMs: 10_000 })
    applyRateLimitHeaders(new Headers({ 'x-hubspot-ratelimit-max': '190', 'x-hubspot-ratelimit-interval-milliseconds': '10000' }), limiter)
    expect(limiter.limits).toEqual({ max: 171, intervalMs: 10_000 })
  })

  it('leaves the limit alone when the headers are missing or junk', () => {
    const limiter = new SlidingWindowLimiter({ max: 90, intervalMs: 10_000 })
    applyRateLimitHeaders(new Headers(), limiter)
    applyRateLimitHeaders(new Headers({ 'x-hubspot-ratelimit-max': 'abc', 'x-hubspot-ratelimit-interval-milliseconds': '10000' }), limiter)
    expect(limiter.limits).toEqual({ max: 90, intervalMs: 10_000 })
  })
})
