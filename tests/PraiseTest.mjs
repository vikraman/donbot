import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Praise testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Praise.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })

  it('should respond to "cookie"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant cookie', 'test-room')
    assert.strictEqual(sent.length, 1)
    assert.ok(sent[0].length > 0)
  })

  it('should respond to "good bot"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant good bot', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should respond to "good job"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant good job', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should respond to "good boy donbot"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant good boy donbot', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should track and report the praise count', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant cookie', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant good bot', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant praise count', 'test-room')
    assert.strictEqual(sent[2], "I've been praised 2 times.")
  })

  it('should say it has never been praised when the count is zero', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant praise count', 'test-room')
    assert.strictEqual(sent[0], "I've been praised 0 times.")
  })

  it('should respond to "thanks"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant thanks', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should respond to "thank you"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant thank you', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should say nobody has praised it when asked "who praised you" with no history', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant who praised you', 'test-room')
    assert.strictEqual(sent[0], 'Nobody. Real quiet out there.')
  })

  it('should list who praised it and how often, ranked by count', async () => {
    const alice = robot.brain.userForId('alice-id', { name: 'alice' })
    const bob = robot.brain.userForId('bob-id', { name: 'bob' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(alice, '@Dumbotheelephant cookie', 'test-room')
    await robot.adapter.say(bob, '@Dumbotheelephant cookie', 'test-room')
    await robot.adapter.say(bob, '@Dumbotheelephant good bot', 'test-room')
    await robot.adapter.say(alice, '@Dumbotheelephant who praised you', 'test-room')
    assert.strictEqual(sent.at(-1), '<@bob-id>: 2 times\n<@alice-id>: once')
  })

  it('should not error when there is no discord-like client for reactions', async () => {
    // already loaded in beforeEach with no client set; loading again should not throw
    await assert.doesNotReject(robot.loadFile('./scripts', 'Praise.mjs'))
  })

  it('should count a praise emoji reaction on the bot\'s own message', async () => {
    robot.adapter.client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    await robot.loadFile('./scripts', 'Praise.mjs')

    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { id: 'bot-id' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 1)
  })

  it('should ignore praise emoji reactions on messages from other users', async () => {
    robot.adapter.client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    await robot.loadFile('./scripts', 'Praise.mjs')

    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { id: 'someone-else' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })

  it('should ignore reactions from bots', async () => {
    robot.adapter.client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    await robot.loadFile('./scripts', 'Praise.mjs')

    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { id: 'bot-id' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: true, username: 'otherbot' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })

  it('should ignore non-praise emoji reactions', async () => {
    robot.adapter.client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    await robot.loadFile('./scripts', 'Praise.mjs')

    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    const reaction = {
      partial: false,
      emoji: { name: '😢' },
      message: { channelId: 'room-1', author: { id: 'bot-id' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })
})
