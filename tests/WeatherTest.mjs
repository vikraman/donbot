import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('Weather testing Hubot scripts', () => {
  const state = setupRobot('Weather.mjs')

  it('should report temperature and conditions for a found city', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('geocoding-api')) {
        return { json: async () => ({ results: [{ name: 'London', country: 'United Kingdom', latitude: 51.5, longitude: -0.1 }] }) }
      }
      return { json: async () => ({ current: { temperature_2m: 18.9, weather_code: 0 } }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant weather London', 'test-room')
    assert.strictEqual(sent[0], 'London, United Kingdom: 18.9°C, Clear sky')
  })
  it('should support the "forecast for" alternate phrasing', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('geocoding-api')) {
        return { json: async () => ({ results: [{ name: 'London', country: 'United Kingdom', latitude: 51.5, longitude: -0.1 }] }) }
      }
      return { json: async () => ({ current: { temperature_2m: 18.9, weather_code: 0 } }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant forecast for London', 'test-room')
    assert.strictEqual(sent[0], 'London, United Kingdom: 18.9°C, Clear sky')
  })
  it('should say when a city is not found', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ json: async () => ({ results: [] }) }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant weather Nowhereville', 'test-room')
    assert.strictEqual(sent[0], "Couldn't find a place named Nowhereville.")
  })
})
