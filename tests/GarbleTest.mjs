import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Garble testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Garble.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should keep first and last letters of each word in place', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant garble hello world', 'test-room')
    const words = sent[0].split(' ')
    assert.strictEqual(words.length, 2)
    assert.strictEqual(words[0][0], 'h')
    assert.strictEqual(words[0][words[0].length - 1], 'o')
    assert.strictEqual(words[1][0], 'w')
    assert.strictEqual(words[1][words[1].length - 1], 'd')
  })
  it('should leave short words unchanged', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant garble a to it', 'test-room')
    assert.strictEqual(sent[0], 'a to it')
  })
})
