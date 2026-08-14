import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('Futurama testing Hubot scripts', () => {
  const state = setupRobot('Futurama.mjs')

  it('should reply with a random quote and attribution for "quote"', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ quote: 'Bite my shiny metal ass.', who: 'Bender' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant quote', 'test-room')
    assert.strictEqual(requestedUrl, 'https://bender.sierrasoftworks.com/api/v1/quote')
    assert.strictEqual(sent[0], '"Bite my shiny metal ass." — Bender')
  })

  it('should reply with a character-specific quote for "quote <character>"', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ quote: 'Good news, everyone!', who: 'Professor Farnsworth' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant quote Farnsworth', 'test-room')
    assert.strictEqual(requestedUrl, 'https://bender.sierrasoftworks.com/api/v1/quote/Farnsworth')
    assert.strictEqual(sent[0], '"Good news, everyone!" — Professor Farnsworth')
  })

  it('should support "entertain me" as an alternate phrasing', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({
      ok: true, json: async () => ({ quote: "Shut up and take my money!", who: 'Fry' })
    }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant entertain me', 'test-room')
    assert.strictEqual(sent[0], '"Shut up and take my money!" — Fry')
  })

  it('should say it has no quote when the character is not found', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: false }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant quote Donbot', 'test-room')
    assert.strictEqual(sent[0], "I don't have a quote for that.")
  })
})
