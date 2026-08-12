import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Weather testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Weather.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })
  it('should report temperature and conditions for a found city', async () => {
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('geocoding-api')) {
        return { json: async () => ({ results: [{ name: 'London', country: 'United Kingdom', latitude: 51.5, longitude: -0.1 }] }) }
      }
      return { json: async () => ({ current: { temperature_2m: 18.9, weather_code: 0 } }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant weather London', 'test-room')
    assert.strictEqual(sent[0], 'London, United Kingdom: 18.9°C, Clear sky')
  })
  it('should support the "forecast for" alternate phrasing', async () => {
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('geocoding-api')) {
        return { json: async () => ({ results: [{ name: 'London', country: 'United Kingdom', latitude: 51.5, longitude: -0.1 }] }) }
      }
      return { json: async () => ({ current: { temperature_2m: 18.9, weather_code: 0 } }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant forecast for London', 'test-room')
    assert.strictEqual(sent[0], 'London, United Kingdom: 18.9°C, Clear sky')
  })
  it('should say when a city is not found', async () => {
    mock.method(global, 'fetch', async () => ({ json: async () => ({ results: [] }) }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant weather Nowhereville', 'test-room')
    assert.strictEqual(sent[0], "Couldn't find a place named Nowhereville.")
  })
})
