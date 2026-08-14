import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { scoreTone } from '../scripts/lib/sentiment.mjs'

describe('sentiment lib', () => {
  it('scores a strongly positive message as positive', () => {
    const { tone, score } = scoreTone('this is absolutely wonderful!!! I love it so much')
    assert.strictEqual(tone, 'positive')
    assert.ok(score > 0)
  })

  it('scores a strongly negative message as negative', () => {
    const { tone, score } = scoreTone('this is terrible, I hate it, worst thing ever')
    assert.strictEqual(tone, 'negative')
    assert.ok(score < 0)
  })

  it('scores a flat, short acknowledgement as neutral', () => {
    assert.strictEqual(scoreTone('thanks').tone, 'neutral')
    assert.strictEqual(scoreTone('thank you').tone, 'neutral')
  })

  it('scores an unrelated neutral message as neutral', () => {
    assert.strictEqual(scoreTone('nothing interesting here').tone, 'neutral')
  })

  it('returns a numeric comparative alongside the tone', () => {
    const result = scoreTone('good job')
    assert.strictEqual(typeof result.comparative, 'number')
  })
})
