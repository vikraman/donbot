import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { formatDuration, formatAgo } from '../scripts/lib/duration.ts'
import { fc } from './helpers/arb.ts'

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

describe('duration', () => {
  it('shows the two largest units and drops zeros', () => {
    assert.strictEqual(formatDuration(0), '0s')
    assert.strictEqual(formatDuration(-5 * S), '0s')
    assert.strictEqual(formatDuration(45 * S), '45s')
    assert.strictEqual(formatDuration(M), '1m')
    assert.strictEqual(formatDuration(90 * S), '1m 30s')
    assert.strictEqual(formatDuration(H + 30 * M + 59 * S), '1h 30m')
    assert.strictEqual(formatDuration(H + 5 * S), '1h')
    assert.strictEqual(formatDuration(2 * D + 3 * H + 4 * M), '2d 3h')
    assert.strictEqual(formatDuration(40 * D), '40d')
  })

  it('rounds at the smallest shown unit, carrying up', () => {
    assert.strictEqual(formatDuration(400), '0s')
    assert.strictEqual(formatDuration(400, { round: Math.ceil }), '1s')
    assert.strictEqual(formatDuration(59 * M + 59 * S + 1, { round: Math.ceil }), '1h')
    assert.strictEqual(formatDuration(H + 59 * M + 30 * S, { round: Math.round }), '2h')
  })

  it('shows more units on request', () => {
    assert.strictEqual(formatDuration(3 * H + 12 * M + 47 * S, { units: 3 }), '3h 12m 47s')
    assert.strictEqual(formatDuration(H + 30 * S, { units: 3 }), '1h 30s')
    assert.strictEqual(formatDuration(2 * D + 3 * H + 4 * M + 5 * S, { units: 3 }), '2d 3h 4m')
    assert.strictEqual(formatDuration(D + 59 * M + 59 * S + 1, { units: 3, round: Math.ceil }), '1d 1h')
    assert.strictEqual(formatDuration(45 * S, { units: 1 }), '45s')
    assert.strictEqual(formatDuration(H + 59 * M, { units: 1 }), '1h')
  })

  it('formats elapsed time', () => {
    const now = 10 * D
    assert.strictEqual(formatAgo(now - 59 * S, now), 'just now')
    assert.strictEqual(formatAgo(now - 3 * M, now), '3m ago')
    assert.strictEqual(formatAgo(now - 26 * H, now), '1d 2h ago')
  })
})

describe('duration properties', () => {
  const SIZES: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }
  const ORDER = Object.keys(SIZES)
  const parse = (out: string) => out.split(' ').map(p => ({ unit: p.at(-1)!, n: Number(p.slice(0, -1)) }))
  const sum = (out: string) => parse(out).reduce((t, p) => t + p.n * SIZES[p.unit]!, 0)
  const ms = fc.integer({ min: 0, max: 400 * 86_400_000 })
  const units = fc.integer({ min: 1, max: 4 })

  it('shows at most n descending units, floored within the smallest window unit', () => {
    fc.assert(fc.property(ms, units, (t, n) => {
      const out = formatDuration(t, { units: n })
      const parts = parse(out)
      assert.ok(parts.length <= n)
      const idx = parts.map(p => ORDER.indexOf(p.unit))
      assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b))
      assert.strictEqual(new Set(idx).size, idx.length)
      const first = Math.max(0, ORDER.findIndex(u => t >= SIZES[u]!))
      const step = SIZES[ORDER[Math.min(first + n - 1, 3)]!]!
      assert.ok(sum(out) <= t && t - sum(out) < step, out)
    }))
  })

  it('is monotonic', () => {
    fc.assert(fc.property(ms, ms, units, (a, b, n) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      assert.ok(sum(formatDuration(lo, { units: n })) <= sum(formatDuration(hi, { units: n })))
    }))
  })
})
