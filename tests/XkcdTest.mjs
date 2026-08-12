import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Xkcd testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Xkcd.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })
  it('should fetch the latest comic when no number is given', async () => {
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ title: 'Size and Lifespan', img: 'https://imgs.xkcd.com/comics/size_and_lifespan.png' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant xkcd', 'test-room')
    assert.strictEqual(requestedUrl, 'https://xkcd.com/info.0.json')
    assert.strictEqual(sent[0], 'Size and Lifespan: https://imgs.xkcd.com/comics/size_and_lifespan.png')
  })
  it('should fetch a specific comic number when given', async () => {
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ title: 'Barrel - Part 1', img: 'https://imgs.xkcd.com/comics/barrel_part_1.jpg' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant xkcd 1', 'test-room')
    assert.strictEqual(requestedUrl, 'https://xkcd.com/1/info.0.json')
  })
  it('should support "xkcd comic" as an alternate phrasing', async () => {
    mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ title: 'Test', img: 'https://imgs.xkcd.com/comics/test.png' }) }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant xkcd comic', 'test-room')
    assert.strictEqual(sent[0], 'Test: https://imgs.xkcd.com/comics/test.png')
  })
})
