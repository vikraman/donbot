import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Plusplus testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Plusplus.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should increment a score on ++', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, 'donbot++', 'test-room')
    assert.strictEqual(sent[0], 'donbot: 1')
  })
  it('should decrement a score on --', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, 'donbot--', 'test-room')
    assert.strictEqual(sent[0], 'donbot: -1')
  })
  it('should accumulate score across multiple messages', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, 'donbot++', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 2')
  })
  it('should report score via the score command', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant score for donbot', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 1')
  })
})
