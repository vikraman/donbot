import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('RateLimit testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'RateLimit.mjs')
    robot.respond(/ping$/i, async res => { await res.send('pong') })
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    delete process.env.OWNER_USER_ID
    robot.shutdown()
    mock.reset()
  })

  it('should respond normally while under the limit', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 5; i++) {
      await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    }
    assert.strictEqual(sent.length, 5)
    assert.ok(sent.every(s => s === 'pong'))
  })

  it('should cut off and send a dismissal once the limit is exceeded', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) {
      await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    }
    assert.strictEqual(sent.length, 6)
    assert.notStrictEqual(sent[5], 'pong')
  })

  it('should stay silent on further messages during the cooldown, not repeat the dismissal', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) {
      await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    }
    const countAfterCutoff = sent.length
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.length, countAfterCutoff)
  })

  it('should resume responding after the cooldown window passes', async () => {
    let now = Date.now()
    mock.method(Date, 'now', () => now)

    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) {
      await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    }
    const countAfterCutoff = sent.length

    now += 31 * 1000 // first offense cooldown is 30s
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.length, countAfterCutoff + 1)
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('should double the cooldown on each consecutive offense', async () => {
    let now = Date.now()
    mock.method(Date, 'now', () => now)

    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    // first offense: cooldown ~30s
    for (let i = 0; i < 6; i++) await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    now += 31 * 1000
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room') // resets window, consumes 1 slot
    assert.strictEqual(sent.at(-1), 'pong')

    // trip a second offense right away
    for (let i = 0; i < 5; i++) await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    const afterSecondOffense = sent.length
    assert.notStrictEqual(sent.at(-1), 'pong')

    // second offense cooldown should be ~60s: not yet expired at +31s
    now += 31 * 1000
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.length, afterSecondOffense, 'should still be in cooldown after 31s on a second offense')

    // but expired by +61s total (60s cooldown)
    now += 30 * 1000
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('should reset the offense count after a long enough quiet period', async () => {
    let now = Date.now()
    mock.method(Date, 'now', () => now)

    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })

    // first offense
    for (let i = 0; i < 6; i++) await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.notStrictEqual(sent.at(-1), 'pong')

    // quiet for long enough to reset the offense streak, and past the 30s cooldown
    now += 16 * 60 * 1000
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.at(-1), 'pong')

    // trip a fresh offense: should use the base ~30s cooldown again, not an escalated one
    for (let i = 0; i < 5; i++) await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    now += 31 * 1000
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('should track limits per user independently', async () => {
    const alice = robot.brain.userForId('alice-id', { name: 'alice' })
    const bob = robot.brain.userForId('bob-id', { name: 'bob' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) {
      await robot.adapter.say(alice, '@Dumbotheelephant ping', 'test-room')
    }
    await robot.adapter.say(bob, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('should track limits per room independently', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) {
      await robot.adapter.say(user, '@Dumbotheelephant ping', 'room-a')
    }
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'room-b')
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('should exempt the configured owner user id from rate limiting', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'the boss' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 20; i++) {
      await robot.adapter.say(owner, '@Dumbotheelephant ping', 'test-room')
    }
    assert.strictEqual(sent.length, 20)
    assert.ok(sent.every(s => s === 'pong'))
  })

  it('should still rate-limit non-owner users when an owner is configured', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) {
      await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    }
    assert.notStrictEqual(sent.at(-1), 'pong')
  })

  it('should not count unaddressed chatter toward the limit', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 10; i++) {
      await robot.adapter.say(user, 'just chatting away', 'test-room')
    }
    await robot.adapter.say(user, '@Dumbotheelephant ping', 'test-room')
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0], 'pong')
  })

  it('should refuse to report rate-limited users to a non-owner', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, "@Dumbotheelephant who's rate limited", 'test-room')
    assert.strictEqual(sent[0], "That's need-to-know, and you don't need to know.")
  })

  it('should say nobody is rate limited when the owner asks and no one is', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'boss' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(owner, "@Dumbotheelephant who's rate limited", 'test-room')
    assert.strictEqual(sent[0], 'Nobody in the doghouse right now.')
  })

  it('should list currently rate-limited users for the owner', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'boss' })
    const pest = robot.brain.userForId('pest-id', { name: 'pest' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) await robot.adapter.say(pest, '@Dumbotheelephant ping', 'test-room')
    await robot.adapter.say(owner, "@Dumbotheelephant who's rate limited", 'test-room')
    assert.match(sent.at(-1), /^<@pest-id> in test-room: .+ left \(offense #1\)$/)
  })

  it('should resolve the room to a real channel name when a discord client is present', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'boss' })
    const pest = robot.brain.userForId('pest-id', { name: 'pest' })
    robot.adapter.client = {
      channels: { cache: new Map([['test-room', { name: 'general' }]]) }
    }
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) await robot.adapter.say(pest, '@Dumbotheelephant ping', 'test-room')
    await robot.adapter.say(owner, "@Dumbotheelephant who's rate limited", 'test-room')
    assert.match(sent.at(-1), /^<@pest-id> in #general: .+ left \(offense #1\)$/)
  })

  it('should fall back to the raw room id when there is no matching channel', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'boss' })
    const pest = robot.brain.userForId('pest-id', { name: 'pest' })
    robot.adapter.client = { channels: { cache: new Map() } }
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) await robot.adapter.say(pest, '@Dumbotheelephant ping', 'test-room')
    await robot.adapter.say(owner, "@Dumbotheelephant who's rate limited", 'test-room')
    assert.match(sent.at(-1), /^<@pest-id> in test-room: .+ left \(offense #1\)$/)
  })

  it('should support "rate limits" as a shorter phrasing', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'boss' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(owner, '@Dumbotheelephant rate limits', 'test-room')
    assert.strictEqual(sent[0], 'Nobody in the doghouse right now.')
  })

  it('should support "rate limit status" as a shorter phrasing', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'boss' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(owner, '@Dumbotheelephant rate limit status', 'test-room')
    assert.strictEqual(sent[0], 'Nobody in the doghouse right now.')
  })

  it('should not list users whose cooldown has already expired', async () => {
    let now = Date.now()
    mock.method(Date, 'now', () => now)
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = robot.brain.userForId('owner-id', { name: 'boss' })
    const pest = robot.brain.userForId('pest-id', { name: 'pest' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    for (let i = 0; i < 6; i++) await robot.adapter.say(pest, '@Dumbotheelephant ping', 'test-room')
    now += 31 * 1000
    await robot.adapter.say(owner, "@Dumbotheelephant who's rate limited", 'test-room')
    assert.strictEqual(sent.at(-1), 'Nobody in the doghouse right now.')
  })
})
