import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Choose testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Choose.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })
  it('should pick one of the given options using random.org', async () => {
    mock.method(global, 'fetch', async () => ({ ok: true, text: async () => '1\n' }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant choose pizza or tacos', 'test-room')
    assert.strictEqual(sent[0], 'tacos')
  })
  it('should support "pick" as an alternate trigger word', async () => {
    mock.method(global, 'fetch', async () => ({ ok: true, text: async () => '0\n' }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant pick pizza or tacos', 'test-room')
    assert.strictEqual(sent[0], 'pizza')
  })
  it('should complain with fewer than two options', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant choose pizza', 'test-room')
    assert.match(sent[0], /at least two options/)
  })
  it('should fall back to local randomness when random.org fails', async () => {
    mock.method(global, 'fetch', async () => { throw new Error('network down') })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant choose pizza or tacos', 'test-room')
    assert.ok(['pizza', 'tacos'].includes(sent[0]))
  })
  it('should roll a single number in range', async () => {
    mock.method(global, 'fetch', async () => ({ ok: true, text: async () => '42\n' }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant roll a number between 1 and 100', 'test-room')
    assert.strictEqual(sent[0], '42')
  })
  it('should roll multiple numbers in range', async () => {
    mock.method(global, 'fetch', async () => ({ ok: true, text: async () => '3\n7\n9\n' }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant roll 3 numbers between 1 and 10', 'test-room')
    assert.strictEqual(sent[0], '3, 7, 9')
  })
})
