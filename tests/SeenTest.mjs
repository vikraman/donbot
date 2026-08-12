import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Seen testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Seen.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should say it has not seen an unknown user', async () => {
    const user = robot.brain.userForId('author-id', { name: 'author' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant seen nobody', 'test-room')
    assert.strictEqual(sent[0], "I don't know anything about nobody.")
  })
  it('should report the last seen time for a user after they speak', async () => {
    const author = robot.brain.userForId('author-id', { name: 'author' })
    const holman = robot.brain.userForId('holman-id', { name: 'holman' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(holman, 'hello there', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant seen holman', 'test-room')
    assert.match(sent[0], /^holman was last seen /)
  })
  it('should support "have you seen" as an alternate phrasing', async () => {
    const author = robot.brain.userForId('author-id', { name: 'author' })
    const holman = robot.brain.userForId('holman-id', { name: 'holman' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(holman, 'hello there', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant have you seen holman', 'test-room')
    assert.match(sent[0], /^holman was last seen /)
  })
})
