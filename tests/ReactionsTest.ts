import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { APPROVAL, baseEmoji, isApproval, LAUGH, NEGATIVE, valenceOf } from '../scripts/lib/reactions.ts'

describe('reactions', () => {
  it('keeps the groups apart', () => {
    for (const e of NEGATIVE) assert.strictEqual(APPROVAL.has(e) || LAUGH.has(e), false, `${e} is in two groups`)
    for (const e of LAUGH) assert.strictEqual(APPROVAL.has(e), false, `${e} is in two groups`)
  })
  it('reads gen z reactions', () => {
    for (const e of ['💀', '☠️', '😭', '🐐', '🫶', '💅', '🤌', '🫡', '🔥', '💯']) assert.strictEqual(valenceOf(e), 1, e)
    for (const e of ['🤡', '🧢', '🚩', '🤨', '😬', '🙄', '🥱', '🫠']) assert.strictEqual(valenceOf(e), -1, e)
  })
  it('ignores neutral and owned emoji', () => {
    for (const e of ['⭐', '🐙', '🤔', '👀', '😤']) assert.strictEqual(valenceOf(e), 0, e)
  })
  it('treats skin tones, gender signs and variation selectors as the base emoji', () => {
    assert.strictEqual(baseEmoji('👍🏽'), '👍')
    assert.strictEqual(baseEmoji('🤦‍♂️'), '🤦')
    assert.strictEqual(valenceOf('👏🏿'), 1)
    assert.strictEqual(valenceOf('🤦🏻‍♀️'), -1)
    assert.strictEqual(valenceOf('❤'), 1)
    assert.strictEqual(valenceOf('☠'), 1)
  })
  it('counts only approval as praise', () => {
    assert.strictEqual(isApproval('🙏🏼'), true)
    assert.strictEqual(isApproval('😂'), false)
    assert.strictEqual(isApproval('👎'), false)
  })
})
