import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isRareWord, wordRank } from '../scripts/lib/wordRarity.ts'

describe('wordRarity lib', () => {
  it('treats common English words as not rare', () => {
    for (const word of ['faster', 'better', 'container', 'printer', 'manager', 'compiler']) {
      assert.strictEqual(isRareWord(word), false, `expected "${word}" to be common`)
    }
  })

  it('treats obscure jargon words as rare', () => {
    for (const word of ['functor', 'monad', 'tensor', 'transformer']) {
      assert.strictEqual(isRareWord(word), true, `expected "${word}" to be rare`)
    }
  })

  it('is case-insensitive', () => {
    assert.strictEqual(isRareWord('Functor'), true)
    assert.strictEqual(isRareWord('FASTER'), false)
  })
})

describe('wordRank', () => {
  it('ranks common words ahead of less common ones', () => {
    assert.ok(wordRank('the') < wordRank('breakfast'))
    assert.ok(wordRank('breakfast') < 10000)
  })

  it('returns infinity for words outside the list', () => {
    assert.strictEqual(wordRank('tentacle'), Infinity)
  })

  it('is case-insensitive', () => {
    assert.strictEqual(wordRank('Breakfast'), wordRank('breakfast'))
  })
})
