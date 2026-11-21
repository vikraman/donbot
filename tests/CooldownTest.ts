import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { burst, cooldown } from '../scripts/lib/cooldown.ts'
import { fc } from './helpers/arb.ts'

describe('cooldown', () => {
  it('should be ready for an unmarked key', () => {
    assert.ok(cooldown(1000).ready('a', 0))
  })

  it('should not be ready until the window has passed', () => {
    const c = cooldown(1000)
    c.mark('a', 0)
    assert.ok(!c.ready('a', 999))
    assert.ok(c.ready('a', 1000))
  })

  it('should keep keys independent', () => {
    const c = cooldown(1000)
    c.mark('a', 0)
    assert.ok(c.ready('b', 1))
  })

  it('should mark only when take succeeds', () => {
    const c = cooldown(1000)
    assert.ok(c.take('a', 0))
    assert.ok(!c.take('a', 500))
    // the failed take did not extend the window
    assert.ok(c.take('a', 1000))
  })

  it('should restart the window when a key is marked again', () => {
    const c = cooldown(1000)
    c.mark('a', 0)
    c.mark('b', 100)
    c.mark('a', 500)
    assert.ok(c.ready('b', 1100))
    assert.ok(!c.ready('a', 1100))
    assert.ok(c.ready('a', 1500))
  })
})

describe('burst', () => {
  it('should allow up to the limit within the window', () => {
    const b = burst(3, 1000)
    assert.ok(b.take('a', 0))
    assert.ok(b.take('a', 1))
    assert.ok(b.take('a', 2))
    assert.ok(!b.take('a', 3))
  })

  it('should free a slot as each hit leaves the window', () => {
    const b = burst(2, 1000)
    b.take('a', 0)
    b.take('a', 500)
    assert.ok(!b.take('a', 999))
    assert.ok(b.take('a', 1000))
    assert.ok(!b.take('a', 1001))
  })

  it('should not count refused takes', () => {
    const b = burst(1, 1000)
    b.take('a', 0)
    assert.ok(!b.take('a', 500))
    assert.ok(b.take('a', 1000))
  })

  it('should keep keys independent', () => {
    const b = burst(1, 1000)
    b.take('a', 0)
    assert.ok(b.take('b', 0))
  })
})

describe('cooldown properties', () => {
  // monotonic clock, few keys
  const ops = <T>(op: fc.Arbitrary<T>) => fc.array(fc.record({ key: fc.constantFrom('a', 'b', 'c'), dt: fc.integer({ min: 0, max: 15 }), op }), { maxLength: 60 })
  const window = fc.integer({ min: 1, max: 30 })

  it('matches a last-mark model', () => {
    fc.assert(fc.property(window, ops(fc.constantFrom('ready', 'mark', 'take')), (ms, steps) => {
      const real = cooldown(ms)
      const marks = new Map<string, number>()
      const ready = (key: string, now: number) => !marks.has(key) || now - marks.get(key)! >= ms
      let now = 0
      for (const { key, dt, op } of steps) {
        now += dt
        if (op === 'mark') { real.mark(key, now); marks.set(key, now); continue }
        const expected = ready(key, now)
        if (op === 'take' && expected) marks.set(key, now)
        assert.strictEqual(real[op](key, now), expected)
      }
    }))
  })

  it('matches a sliding-window model', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 5 }), window, ops(fc.constant(null)), (limit, ms, steps) => {
      const real = burst(limit, ms)
      const hits = new Map<string, number[]>()
      let now = 0
      for (const { key, dt } of steps) {
        now += dt
        const recent = (hits.get(key) ?? []).filter(t => now - t < ms)
        const expected = recent.length < limit
        if (expected) recent.push(now)
        hits.set(key, recent)
        assert.strictEqual(real.take(key, now), expected)
      }
    }))
  })
})
