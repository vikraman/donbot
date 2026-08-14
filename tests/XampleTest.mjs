import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, brainUser } from './helpers/setup.mjs'

// Mocks Aren't Stubs
// https://www.martinfowler.com/articles/mocksArentStubs.html

describe('Xample testing Hubot scripts', () => {
  const state = setupRobot('Xample.mjs')

  it('should handle /helo request', async () => {
    const { robot } = state
    const expected = "HELO World! I'm Dumbotheelephant."
    const url = 'http://localhost:' + robot.server.address().port + '/helo'
    const response = await fetch(url)
    const actual = await response.text()
    assert.strictEqual(actual, expected)
  })
  it('should reply with expected message', async () => {
    const { robot } = state
    const expected = "HELO World! I'm Dumbotheelephant."
    const user = brainUser(robot, 'test-user', 'test user')
    let actual = ''
    robot.on('reply', (envelope, ...strings) => {
      actual = strings.join('')
    })
    await robot.adapter.say(user, '@Dumbotheelephant helo', 'test-room')
    assert.strictEqual(actual, expected)
  })

  it('should send message to the #general room', async () => {
    const { robot } = state
    const expected = 'general'
    const user = brainUser(robot, 'test-user', 'test user')
    let actual = ''
    robot.on('send', (envelope, ...strings) => {
      actual = envelope.room
    })
    await robot.adapter.say(user, '@Dumbotheelephant helo room', 'general')
    assert.strictEqual(actual, expected)
  })
})
