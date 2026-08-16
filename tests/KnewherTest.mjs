import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, brainUser } from './helpers/setup.mjs'

describe('Knewher testing Hubot scripts', () => {
  const state = setupRobot('Knewher.mjs')

  it('should send the joke for a matching word when the roll succeeds', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0)
    const user = brainUser(robot, 'test-user', 'test user')
    let actual = ''
    robot.on('send', (envelope, ...strings) => {
      actual = strings.join('')
    })
    await robot.adapter.say(user, 'functor', 'test-room')
    assert.match(actual, /^Functor\? /)
  })
  it('should stay quiet when the roll fails', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.999)
    const user = brainUser(robot, 'test-user', 'test user')
    let sent = false
    robot.on('send', () => { sent = true })
    await robot.adapter.say(user, 'functor', 'test-room')
    assert.strictEqual(sent, false)
  })
  it('should stay quiet for common words even though they match the -or/-er shape', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0)
    const user = brainUser(robot, 'test-user', 'test user')
    let sent = false
    robot.on('send', () => { sent = true })
    for (const word of ['faster', 'better', 'container', 'printer', 'manager', 'compiler']) {
      await robot.adapter.say(user, word, 'test-room')
    }
    assert.strictEqual(sent, false)
  })
})
