import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('Plusplus testing Hubot scripts', () => {
  const state = setupRobot('Plusplus.mjs')

  it('should increment a score on ++', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    assert.strictEqual(sent[0], 'donbot: 1')
  })
  it('should decrement a score on --', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot--', 'test-room')
    assert.strictEqual(sent[0], 'donbot: -1')
  })
  it('should accumulate score across multiple messages', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, 'donbot++', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 2')
  })
  it('should report score via the score command', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant score for donbot', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 1')
  })
  it('should support "points for" as an alternate phrasing', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant points for donbot', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 1')
  })
})
