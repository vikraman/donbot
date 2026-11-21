import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'

describe('Define', () => {
  const state = setupRobot('Define.ts')

  for (const text of ['define hello', 'what does hello mean']) {
    it(`reports the first definition for "${text}"`, async () => {
      const urls = mockFetch([{ meanings: [{ partOfSpeech: 'exclamation', definitions: [{ definition: 'used as a greeting.' }] }] }])
      const { sent, ask } = chat(state)
      await ask(text)
      assert.deepStrictEqual(urls, ['https://api.dictionaryapi.dev/api/v2/entries/en/hello'])
      assert.strictEqual(sent[0], 'hello (exclamation): used as a greeting.')
    })
  }

  it('says when no definition is found', async () => {
    mockFetch(null, { ok: false })
    const { sent, ask } = chat(state)
    await ask('define zzzznotaword')
    assert.strictEqual(sent[0], 'No definition found for zzzznotaword.')
  })
})
