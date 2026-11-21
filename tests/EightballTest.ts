import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'

describe('Eightball', () => {
  const state = setupRobot('Eightball.ts')

  it('answers both trigger phrases from twenty distinct answers', async () => {
    const { sent, ask } = chat(state)
    for (let i = 0; i < 10; i++) {
      await ask('8ball will it work?')
      await ask('magic 8 ball will it rain?')
    }
    assert.strictEqual(new Set(sent).size, 20)
  })
})
