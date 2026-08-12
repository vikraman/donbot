import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Count testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Count.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should increment the count across messages', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const replies = []
    robot.on('reply', (envelope, ...strings) => {
      replies.push(strings.join(''))
    })
    await robot.adapter.say(user, '@Dumbotheelephant count', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant count', 'test-room')
    assert.strictEqual(replies[0], 'Count is now 1')
    assert.strictEqual(replies[1], 'Count is now 2')
  })
  it('should support "counter" as an alternate trigger word', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const replies = []
    robot.on('reply', (envelope, ...strings) => { replies.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant counter', 'test-room')
    assert.strictEqual(replies[0], 'Count is now 1')
  })
})
