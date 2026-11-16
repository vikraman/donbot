import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { APPROVAL, baseEmoji, isApproval, LAUGH, NEGATIVE, valenceOf } from '../scripts/lib/reactions.ts'

describe('reactions', () => {
  it('keeps the groups apart', () => {
    for (const e of NEGATIVE) assert.equal(APPROVAL.has(e) || LAUGH.has(e), false, `${e} is in two groups`)
    for (const e of LAUGH) assert.equal(APPROVAL.has(e), false, `${e} is in two groups`)
  })
  it('has long lists', () => {
    assert.ok(APPROVAL.size >= 60)
    assert.ok(LAUGH.size >= 20)
    assert.ok(NEGATIVE.size >= 50)
  })
  it('reads gen z reactions', () => {
    for (const e of ['💀', '☠️', '😭', '🐐', '🫶', '💅', '🤌', '🫡', '🔥', '💯']) assert.equal(valenceOf(e), 1, e)
    for (const e of ['🤡', '🧢', '🚩', '🤨', '😬', '🙄', '🥱', '🫠']) assert.equal(valenceOf(e), -1, e)
  })
  it('ignores neutral and owned emoji', () => {
    for (const e of ['⭐', '🐙', '🤔', '👀', '😤']) assert.equal(valenceOf(e), 0, e)
  })
  it('treats skin tones, gender signs and variation selectors as the base emoji', () => {
    assert.equal(baseEmoji('👍🏽'), '👍')
    assert.equal(baseEmoji('🤦‍♂️'), '🤦')
    assert.equal(valenceOf('👏🏿'), 1)
    assert.equal(valenceOf('🤦🏻‍♀️'), -1)
    assert.equal(valenceOf('❤'), 1)
    assert.equal(valenceOf('☠'), 1)
  })
  it('counts only approval as praise', () => {
    assert.equal(isApproval('🙏🏼'), true)
    assert.equal(isApproval('😂'), false)
    assert.equal(isApproval('👎'), false)
  })
})
