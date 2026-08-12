import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Status testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Status.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should report a simple status by default', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status', 'test-room')
    assert.match(sent[0], /^Uptime: .+ \| Brain: connected \| All good\.$/)
    assert.doesNotMatch(sent[0], /Memory: /)
    assert.doesNotMatch(sent[0], /Listeners: /)
  })
  it('should report detailed status with "status verbose"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status verbose', 'test-room')
    assert.match(sent[0], /Uptime: /)
    assert.match(sent[0], /Memory: .+MB \(heap/)
    assert.match(sent[0], /Brain: connected \(.+\) — \d+ users, \d+ keys, [\d.]+ KB/)
    assert.match(sent[0], /Listeners: \d+/)
    assert.match(sent[0], /Node: v/)
    assert.match(sent[0], /Hubot: /)
  })
  it('should report detailed status with "status detailed"', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status detailed', 'test-room')
    assert.match(sent[0], /Memory: /)
  })
  it('should reflect actual user and key counts in verbose brain info', async () => {
    robot.brain.userForId('another-user', { name: 'another user' })
    robot.brain.set('some:custom:key', 'value')
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status verbose', 'test-room')
    const match = sent[0].match(/Brain: connected \(.+\) — (\d+) users, (\d+) keys, [\d.]+ KB/)
    assert.ok(match)
    assert.strictEqual(Number(match[1]), 2)
    assert.ok(Number(match[2]) >= 2)
  })
  it('should respond to "how are you" with the simple status', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant how are you', 'test-room')
    assert.match(sent[0], /^Uptime: .+ \| Brain: connected \| All good\.$/)
  })
  it('should report uptime on its own with the uptime command', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant uptime', 'test-room')
    assert.match(sent[0], /^Uptime: \d+h \d+m \d+s$/)
  })
  it('should not include discord info in the simple status', async () => {
    robot.adapter.client = {
      isReady: () => true,
      user: { tag: 'donbot#1234' },
      guilds: { cache: { size: 3 } },
      ws: { ping: 42, status: 0 }
    }
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status', 'test-room')
    assert.doesNotMatch(sent[0], /Discord: /)
  })
  it('should include detailed discord info in verbose status when a ready discord-like client is present', async () => {
    robot.adapter.client = {
      isReady: () => true,
      user: { tag: 'donbot#1234', username: 'donbot' },
      guilds: { cache: { size: 3 } },
      channels: { cache: { size: 12 } },
      users: { cache: { size: 50 } },
      ws: { ping: 42, status: 0 },
      uptime: 90000
    }
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status verbose', 'test-room')
    assert.match(sent[0], /Discord: logged in as donbot#1234/)
    assert.match(sent[0], /Servers: 3, channels: 12, cached users: 50/)
    assert.match(sent[0], /Gateway: Ready, ping 42ms, connected 0h 1m 30s/)
  })
  it('should handle a discord client missing optional fields gracefully', async () => {
    robot.adapter.client = { isReady: () => true }
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant status verbose', 'test-room')
    assert.match(sent[0], /Discord: logged in as unknown/)
    assert.match(sent[0], /Servers: unknown, channels: unknown, cached users: unknown/)
    assert.match(sent[0], /Gateway: unknown, ping unknown, connected unknown/)
  })
})
