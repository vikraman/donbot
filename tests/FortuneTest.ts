import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'

const FORTUNES = 'You will find a bug.\n\nA closure is in your future.\nBeware of off-by-one errors.\n'

describe('Fortune', () => {
  const state = setupRobot('Fortune.ts')

  it('empties the jar before repeating', async () => {
    mockFetch(FORTUNES)
    const { sent, ask } = chat(state)
    for (let i = 0; i < 3; i++) await ask('fortune')
    assert.deepStrictEqual([...sent].sort(), ['A closure is in your future.', 'Beware of off-by-one errors.', 'You will find a bug.'])
  })

  it('says so when the jar is unreachable', async () => {
    mockFetch(null, { ok: false })
    const { sent, ask } = chat(state)
    await ask('fortune')
    assert.strictEqual(sent[0], 'Fortune unavailable.')
  })
})
