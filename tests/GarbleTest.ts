import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('Garble testing Hubot scripts', () => {
  const state = setupRobot('Garble.ts')

  it('should keep first and last letters of each word in place', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant garble hello world', 'test-room')
    const words = sent[0]!.split(' ')
    assert.strictEqual(words.length, 2)
    assert.strictEqual(words[0]![0], 'h')
    assert.strictEqual(words[0]![words[0]!.length - 1], 'o')
    assert.strictEqual(words[1]![0], 'w')
    assert.strictEqual(words[1]![words[1]!.length - 1], 'd')
  })
  it('should leave short words unchanged', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant garble a to it', 'test-room')
    assert.strictEqual(sent[0], 'a to it')
  })
  it('should support "scramble" as an alternate trigger word', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant scramble hello', 'test-room')
    assert.strictEqual(sent[0]![0], 'h')
  })
})
