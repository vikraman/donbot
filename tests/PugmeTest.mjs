import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Pugme testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Pugme.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })
  it('should send the image url from the api response', async () => {
    mock.method(global, 'fetch', async () => ({
      json: async () => ({ message: 'https://images.dog.ceo/breeds/pug/example.jpg', status: 'success' })
    }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant pug me', 'test-room')
    assert.strictEqual(sent[0], 'https://images.dog.ceo/breeds/pug/example.jpg')
  })
  it('should support the "show me a pug" alternate phrasing', async () => {
    mock.method(global, 'fetch', async () => ({
      json: async () => ({ message: 'https://images.dog.ceo/breeds/pug/example2.jpg', status: 'success' })
    }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant show me a pug', 'test-room')
    assert.strictEqual(sent[0], 'https://images.dog.ceo/breeds/pug/example2.jpg')
  })
})
