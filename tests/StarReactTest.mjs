import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { setupRobot, collect } from './helpers/setup.mjs'

describe('StarReact testing Hubot scripts', () => {
  const state = setupRobot('StarReact.mjs', { deferLoad: true })

  it('should not error when the adapter has no discord client', async () => {
    await assert.doesNotReject(state.loadScript())
  })
  it('should announce when a non-bot user adds a star reaction', async () => {
    const { robot } = state
    robot.adapter.client = new EventEmitter()
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '⭐' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent[0], '⭐ bob starred a message from alice')
  })
  it('should ignore reactions from bots', async () => {
    const { robot } = state
    robot.adapter.client = new EventEmitter()
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '⭐' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: true, username: 'otherbot' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })
  it('should ignore non-star reactions', async () => {
    const { robot } = state
    robot.adapter.client = new EventEmitter()
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    robot.adapter.client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })
})
