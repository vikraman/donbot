import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Define testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Define.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })
  it('should report the first definition', async () => {
    mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ([{ meanings: [{ partOfSpeech: 'exclamation', definitions: [{ definition: 'used as a greeting.' }] }] }])
    }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant define hello', 'test-room')
    assert.strictEqual(sent[0], 'hello (exclamation): used as a greeting.')
  })
  it('should support the "what does X mean" alternate phrasing', async () => {
    mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ([{ meanings: [{ partOfSpeech: 'exclamation', definitions: [{ definition: 'used as a greeting.' }] }] }])
    }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant what does hello mean', 'test-room')
    assert.strictEqual(sent[0], 'hello (exclamation): used as a greeting.')
  })
  it('should say when no definition is found', async () => {
    mock.method(global, 'fetch', async () => ({ ok: false }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant define zzzznotaword', 'test-room')
    assert.strictEqual(sent[0], 'No definition found for zzzznotaword.')
  })
})
