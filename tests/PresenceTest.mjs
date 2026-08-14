import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot } from './helpers/setup.mjs'

describe('Presence testing Hubot scripts', () => {
  const state = setupRobot('Presence.mjs', { deferLoad: true })

  it('should not error when there is no discord-like client', async () => {
    const { robot } = state
    await state.loadScript()
    robot.brain.emit('connected')
  })

  it('should set an activity on the discord client once connected', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = {
      isReady: () => true,
      user: { setActivity }
    }
    await state.loadScript()
    robot.brain.emit('connected')
    assert.strictEqual(setActivity.mock.calls.length, 1)
    const [text, options] = setActivity.mock.calls[0].arguments
    assert.strictEqual(typeof text, 'string')
    assert.ok(text.length > 0)
    assert.strictEqual(options.type, 4)
  })

  it('should not error when the client is present but not ready', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = {
      isReady: () => false,
      user: { setActivity }
    }
    await state.loadScript()
    robot.brain.emit('connected')
    assert.strictEqual(setActivity.mock.calls.length, 0)
  })

  it('should report the guild count when available', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = {
      isReady: () => true,
      user: { setActivity },
      guilds: { cache: { size: 3 } }
    }
    await state.loadScript()
    const statuses = []
    for (let i = 0; i < 200; i++) {
      robot.brain.emit('connected')
      statuses.push(setActivity.mock.calls.at(-1).arguments[0])
    }
    assert.ok(statuses.includes('In 3 servers'))
  })

  it('should report the listener count', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = { isReady: () => true, user: { setActivity } }
    await state.loadScript()
    const statuses = []
    for (let i = 0; i < 200; i++) {
      robot.brain.emit('connected')
      statuses.push(setActivity.mock.calls.at(-1).arguments[0])
    }
    assert.ok(statuses.some(s => /^Knows \d+ tricks?$/.test(s)))
  })

  it('should report memory usage', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = { isReady: () => true, user: { setActivity } }
    await state.loadScript()
    const statuses = []
    for (let i = 0; i < 200; i++) {
      robot.brain.emit('connected')
      statuses.push(setActivity.mock.calls.at(-1).arguments[0])
    }
    assert.ok(statuses.some(s => /^Using [\d.]+MB$/.test(s)))
  })

  it('should report brain size', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = { isReady: () => true, user: { setActivity } }
    await state.loadScript()
    const statuses = []
    for (let i = 0; i < 200; i++) {
      robot.brain.emit('connected')
      statuses.push(setActivity.mock.calls.at(-1).arguments[0])
    }
    assert.ok(statuses.some(s => /^Brain: [\d.]+ KB$/.test(s)))
  })

  it('should report quiet time since the last message once someone has spoken', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = { isReady: () => true, user: { setActivity } }
    robot.brain.set('seen:last', Date.now() - 5 * 60000)
    await state.loadScript()
    const statuses = []
    for (let i = 0; i < 200; i++) {
      robot.brain.emit('connected')
      statuses.push(setActivity.mock.calls.at(-1).arguments[0])
    }
    assert.ok(statuses.some(s => /^Quiet for \d+m$/.test(s)))
  })

  it('should report today\'s date', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = { isReady: () => true, user: { setActivity } }
    await state.loadScript()
    const statuses = []
    for (let i = 0; i < 200; i++) {
      robot.brain.emit('connected')
      statuses.push(setActivity.mock.calls.at(-1).arguments[0])
    }
    assert.ok(statuses.some(s => /^Today: /.test(s)))
  })

  it('should sometimes show a random emoji mood', async () => {
    const { robot } = state
    const setActivity = mock.fn()
    robot.adapter.client = { isReady: () => true, user: { setActivity } }
    await state.loadScript()
    const statuses = []
    for (let i = 0; i < 200; i++) {
      robot.brain.emit('connected')
      statuses.push(setActivity.mock.calls.at(-1).arguments[0])
    }
    assert.ok(statuses.some(s => /\p{Emoji}/u.test(s) && s.length <= 3))
  })
})
