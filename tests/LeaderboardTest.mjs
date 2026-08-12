import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Leaderboard testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Leaderboard.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should say there are no scores yet', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
    assert.strictEqual(sent[0], 'No scores yet.')
  })
  it('should list scores in descending order', async () => {
    robot.brain.set('plusplus:tacos', 5)
    robot.brain.set('plusplus:pizza', 10)
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
    assert.strictEqual(sent[0], '1. pizza: 10\n2. tacos: 5')
  })
  it('should support "top scores" as an alternate phrasing', async () => {
    robot.brain.set('plusplus:tacos', 5)
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant top scores', 'test-room')
    assert.strictEqual(sent[0], '1. tacos: 5')
  })
})
