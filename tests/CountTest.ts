import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('Count testing Hubot scripts', () => {
  const state = setupRobot('Count.ts')

  it('should increment the count across messages', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const replies = collect(robot, 'reply')
    await robot.adapter.say(user, '@Dumbotheelephant count', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant count', 'test-room')
    assert.strictEqual(replies[0], 'Count is now 1')
    assert.strictEqual(replies[1], 'Count is now 2')
  })
  it('should support "counter" as an alternate trigger word', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const replies = collect(robot, 'reply')
    await robot.adapter.say(user, '@Dumbotheelephant counter', 'test-room')
    assert.strictEqual(replies[0], 'Count is now 1')
  })
})
