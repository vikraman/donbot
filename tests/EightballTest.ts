import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('Eightball testing Hubot scripts', () => {
  const state = setupRobot('Eightball.ts')

  it('should respond with an answer', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant 8ball will it rain?', 'test-room')
    assert.ok(sent[0]!.length > 0)
  })
  it('should support "magic 8 ball" as an alternate trigger phrase', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant magic 8 ball will it rain?', 'test-room')
    assert.ok(sent[0]!.length > 0)
  })
  it('should not repeat an answer until all twenty are used', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    for (let i = 0; i < 20; i++) await robot.adapter.say(user, '@Dumbotheelephant 8ball will it work?', 'test-room')
    assert.strictEqual(new Set(sent).size, 20)
  })
})
