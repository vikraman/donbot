import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { formatDuration, formatAgo } from '../scripts/lib/duration.ts'

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
