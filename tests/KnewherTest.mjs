import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Knewher testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Knewher.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })
  it('should send the joke for a matching word when the roll succeeds', async () => {
    mock.method(Math, 'random', () => 0)
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    let actual = ''
    robot.on('send', (envelope, ...strings) => {
      actual = strings.join('')
    })
    await robot.adapter.say(user, 'functor', 'test-room')
    assert.match(actual, /^Functor\? /)
  })
  it('should stay quiet when the roll fails', async () => {
    mock.method(Math, 'random', () => 0.999)
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    let sent = false
    robot.on('send', () => { sent = true })
    await robot.adapter.say(user, 'functor', 'test-room')
    assert.strictEqual(sent, false)
  })
})
