import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'

describe('Garble', () => {
  const state = setupRobot('Garble.ts')

  for (const verb of ['garble', 'scramble']) {
    it(`keeps first and last letters in place for "${verb}"`, async () => {
      const { sent, ask } = chat(state)
      await ask(`${verb} hello world`)
      const words = sent[0]!.split(' ')
      assert.strictEqual(words.length, 2)
      assert.match(words[0]!, /^h[ell]{3}o$/)
      assert.match(words[1]!, /^w[orl]{3}d$/)
    })
  }

  it('leaves short words unchanged', async () => {
    const { sent, ask } = chat(state)
    await ask('garble a to it')
    assert.strictEqual(sent[0], 'a to it')
  })
})
