import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { Envelope } from 'hubot'

import { setupRobot, brainUser } from './helpers/setup.ts'

// robot.server is the http server hubot creates when httpd is on; not in the ambient types
interface WithServer { server: { address(): { port: number } } }

// Mocks Aren't Stubs
// https://www.martinfowler.com/articles/mocksArentStubs.html

describe('Xample testing Hubot scripts', () => {
  const state = setupRobot('Xample.ts')

  it('should handle /helo request', async () => {
    const { robot } = state
    const expected = "HELO World! I'm Dumbotheelephant."
    const url = 'http://localhost:' + (robot as unknown as WithServer).server.address().port + '/helo'
    const response = await fetch(url)
    const actual = await response.text()
    assert.strictEqual(actual, expected)
  })
  it('should reply with expected message', async () => {
    const { robot } = state
    const expected = "HELO World! I'm Dumbotheelephant."
    const user = brainUser(robot, 'test-user', 'test user')
    let actual = ''
    robot.on('reply', (envelope: Envelope, ...strings: string[]) => {
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
    robot.on('send', (envelope: Envelope, ...strings: string[]) => {
      actual = envelope.room!
    })
    await robot.adapter.say(user, '@Dumbotheelephant helo room', 'general')
    assert.strictEqual(actual, expected)
  })
})
