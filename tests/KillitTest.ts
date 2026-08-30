import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, brainUser } from './helpers/setup.ts'

describe('Killit testing Hubot scripts', () => {
  const state = setupRobot('Killit.ts')

  it('should send the fire joke when the roll succeeds', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0)
    const user = brainUser(robot, 'test-user', 'test user')
    let actual = ''
    robot.on('send', (envelope, ...strings) => {
      actual = strings.join('')
    })
    await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.strictEqual(actual, 'Kill it, kill it with fire!')
  })
  it('should stay quiet when the roll fails', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.999)
    const user = brainUser(robot, 'test-user', 'test user')
    let sent = false
    robot.on('send', () => { sent = true })
    await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.strictEqual(sent, false)
  })
})
