import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

const makeFakeMessage = (id, reactionCounts) => ({
  id,
  reactions: {
    cache: new Map(Object.entries(reactionCounts).map(([emoji, count]) => [
      emoji,
      { partial: false, count, fetch: async () => {} }
    ]))
  }
})

describe('Poll testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Poll.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should say polls only work in discord channels when there is no raw channel', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant poll should we ship it', 'test-room')
    assert.match(sent[0], /only work in Discord channels/)
  })
  it('should post a poll and report results from a discord-like channel', async () => {
    const posted = makeFakeMessage('msg-1', { '👍': 4, '👎': 2 })
    posted.react = async () => {}
    const channel = { send: async () => posted, messages: { fetch: async () => posted } }
    const user = robot.brain.userForId('test-user', {
      name: 'test user',
      message: { channel }
    })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    await robot.adapter.say(user, '@Dumbotheelephant poll should we ship it', 'test-room')
    assert.match(sent[0], /Poll posted/)

    await robot.adapter.say(user, '@Dumbotheelephant poll results', 'test-room')
    assert.strictEqual(sent[1], '"should we ship it" — 👍 3 / 👎 1')
  })
  it('should say no poll has run yet when asked for results first', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant poll results', 'test-room')
    assert.strictEqual(sent[0], 'No poll has been run in this room yet.')
  })
})
