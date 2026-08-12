import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Remind testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Remind.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should acknowledge setting a reminder', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should support the "set a reminder for" alternate phrasing', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant set a reminder for 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should reject an unknown unit', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 fortnights to stretch', 'test-room')
    assert.match(sent[0], /don't understand the unit/)
  })
  it('should fire the reminder after the delay elapses', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 1 seconds to stretch', 'test-room')
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.strictEqual(sent[1], '@test user reminder: stretch')
  })
})
