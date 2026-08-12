import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('StarReact testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should not error when the adapter has no discord client', async () => {
    await assert.doesNotReject(robot.loadFile('./scripts', 'StarReact.mjs'))
  })
  it('should announce when a non-bot user adds a star reaction', async () => {
    robot.adapter.client = new EventEmitter()
    await robot.loadFile('./scripts', 'StarReact.mjs')

    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    const reaction = {
      partial: false,
      emoji: { name: '⭐' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent[0], '⭐ bob starred a message from alice')
  })
  it('should ignore reactions from bots', async () => {
    robot.adapter.client = new EventEmitter()
    await robot.loadFile('./scripts', 'StarReact.mjs')

    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    const reaction = {
      partial: false,
      emoji: { name: '⭐' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: true, username: 'otherbot' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })
  it('should ignore non-star reactions', async () => {
    robot.adapter.client = new EventEmitter()
    await robot.loadFile('./scripts', 'StarReact.mjs')

    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })
})
