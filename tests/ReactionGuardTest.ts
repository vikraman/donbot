import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { reactionGuard } from '../scripts/lib/reactionGuard.ts'
import { clock } from './helpers/fakes.ts'

describe('reactionGuard', () => {
  it('passes each user once per message', () => {
    const g = reactionGuard(60_000)
    assert.strictEqual(g.first('m1', 'bob'), true)
    assert.strictEqual(g.first('m1', 'bob'), false)
    assert.strictEqual(g.first('m1', 'carol'), true)
    assert.strictEqual(g.first('m2', 'bob'), true)
  })

  it('replies once per channel per cooldown', () => {
    const t = clock(1_000_000)
    const g = reactionGuard(60_000)
    assert.strictEqual(g.mayReply('m1', 'room-1'), true)
    assert.strictEqual(g.mayReply('m2', 'room-1'), false)
    assert.strictEqual(g.mayReply('m3', 'room-2'), true)
    t.advance(60_000)
    assert.strictEqual(g.mayReply('m4', 'room-1'), true)
    mock.reset()
  })

  it('never replies to its own messages', () => {
    const g = reactionGuard(0)
    g.remember([{ id: 'own-1' }, { id: 'own-2' }])
    g.remember(undefined)
    assert.strictEqual(g.mayReply('own-1', 'room-1'), false)
    assert.strictEqual(g.mayReply('own-2', 'room-2'), false)
    assert.strictEqual(g.mayReply('other', 'room-3'), true)
  })

  it('forgets the oldest seen reactions past the cap', () => {
    const g = reactionGuard(0)
    for (let i = 0; i <= 1000; i++) g.first(`m${i}`, 'bob')
    assert.strictEqual(g.first('m0', 'bob'), true)
    assert.strictEqual(g.first('m1000', 'bob'), false)
  })
})
