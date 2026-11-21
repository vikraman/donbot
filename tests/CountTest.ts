import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat, collect } from './helpers/setup.ts'

describe('Count', () => {
  const state = setupRobot('Count.ts')

  it('increments across messages and trigger words', async () => {
    const { robot, ask } = chat(state)
    const replies = collect(robot, 'reply')
    await ask('count')
    await ask('counter')
    assert.deepStrictEqual(replies, ['Count is now 1', 'Count is now 2'])
  })
})
