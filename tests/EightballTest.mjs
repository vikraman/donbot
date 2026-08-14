import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('Eightball testing Hubot scripts', () => {
  const state = setupRobot('Eightball.mjs')

  it('should respond with an answer', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant 8ball will it rain?', 'test-room')
    assert.ok(sent[0].length > 0)
  })
  it('should support "magic 8 ball" as an alternate trigger phrase', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant magic 8 ball will it rain?', 'test-room')
    assert.ok(sent[0].length > 0)
  })
})
