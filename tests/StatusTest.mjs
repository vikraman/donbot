import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Status testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Status.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should report uptime, memory, and brain status', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status', 'test-room')
    assert.match(sent[0], /Uptime: /)
    assert.match(sent[0], /Memory: /)
    assert.match(sent[0], /Brain: connected/)
  })
  it('should respond to "how are you" as well', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant how are you', 'test-room')
    assert.match(sent[0], /Uptime: /)
  })
})
