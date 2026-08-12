import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Futurama testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Futurama.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })

  it('should reply with a random quote and attribution for "quote"', async () => {
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ quote: 'Bite my shiny metal ass.', who: 'Bender' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant quote', 'test-room')
    assert.strictEqual(requestedUrl, 'https://bender.sierrasoftworks.com/api/v1/quote')
    assert.strictEqual(sent[0], '"Bite my shiny metal ass." — Bender')
  })

  it('should reply with a character-specific quote for "quote <character>"', async () => {
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ quote: 'Good news, everyone!', who: 'Professor Farnsworth' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant quote Farnsworth', 'test-room')
    assert.strictEqual(requestedUrl, 'https://bender.sierrasoftworks.com/api/v1/quote/Farnsworth')
    assert.strictEqual(sent[0], '"Good news, everyone!" — Professor Farnsworth')
  })

  it('should support "entertain me" as an alternate phrasing', async () => {
    mock.method(global, 'fetch', async () => ({
      ok: true, json: async () => ({ quote: "Shut up and take my money!", who: 'Fry' })
    }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant entertain me', 'test-room')
    assert.strictEqual(sent[0], '"Shut up and take my money!" — Fry')
  })

  it('should say it has no quote when the character is not found', async () => {
    mock.method(global, 'fetch', async () => ({ ok: false }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant quote Donbot', 'test-room')
    assert.strictEqual(sent[0], "I don't have a quote for that.")
  })
})
