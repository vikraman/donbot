import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('Pugme testing Hubot scripts', () => {
  const state = setupRobot('Pugme.mjs')

  it('should send the image url from the api response', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({
      json: async () => ({ message: 'https://images.dog.ceo/breeds/pug/example.jpg', status: 'success' })
    }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant pug me', 'test-room')
    assert.strictEqual(sent[0], 'https://images.dog.ceo/breeds/pug/example.jpg')
  })
  it('should support the "show me a pug" alternate phrasing', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({
      json: async () => ({ message: 'https://images.dog.ceo/breeds/pug/example2.jpg', status: 'success' })
    }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant show me a pug', 'test-room')
    assert.strictEqual(sent[0], 'https://images.dog.ceo/breeds/pug/example2.jpg')
  })
})
