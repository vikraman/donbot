import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const FORTUNES = 'You will find a bug.\n\nA closure is in your future.\nBeware of off-by-one errors.\n'

describe('Fortune', () => {
  const state = setupRobot('Fortune.ts')

  it('should not repeat a fortune until the jar is empty', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: true, text: async () => FORTUNES }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    for (let i = 0; i < 3; i++) await robot.adapter.say(user, '@Dumbotheelephant fortune', 'test-room')
    assert.deepStrictEqual([...sent].sort(), ['A closure is in your future.', 'Beware of off-by-one errors.', 'You will find a bug.'])
  })
  it('should say so when the jar is unreachable', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: false }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant fortune', 'test-room')
    assert.strictEqual(sent[0], 'Fortune unavailable.')
  })
})
