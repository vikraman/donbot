import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import type { DiscordClient } from 'hubot'

import { setupRobot, collect, sendReturnsIds, inGuild } from './helpers/setup.ts'

describe('StarReact testing Hubot scripts', () => {
  const state = setupRobot('StarReact.ts', { deferLoad: true })

  it('should not error when the adapter has no discord client', async () => {
    await assert.doesNotReject(state.loadScript())
  })
  it('should announce when a non-bot user adds a star reaction', async () => {
    const { robot } = state
    const client = new EventEmitter()
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '⭐' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent[0], '⭐ bob starred a message from alice')
  })
  it('stays quiet in professional servers', async () => {
    const { robot } = state
    const client = new EventEmitter()
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()
    inGuild(robot, 'g1', ['pro-room'])
    const sent = collect(robot)
    const reaction = { partial: false, emoji: { name: '⭐' }, message: { channelId: 'pro-room', author: { username: 'alice' } } }
    client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepStrictEqual(sent, [])
  })
  it('should ignore reactions from bots', async () => {
    const { robot } = state
    const client = new EventEmitter()
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '⭐' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: true, username: 'otherbot' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })
  it('should ignore non-star reactions', async () => {
    const { robot } = state
    const client = new EventEmitter()
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { username: 'alice' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })

  describe('star spam', () => {
    const setupClient = async () => {
      const { robot } = state
      const client = new EventEmitter()
      robot.adapter.client = client as unknown as DiscordClient
      sendReturnsIds(robot, 'announce')
      await state.loadScript()
      const sent = collect(robot)
      const star = async (userId: string, messageId = 'msg-1', channelId = 'room-1') => {
        const reaction = {
          partial: false,
          emoji: { name: '⭐' },
          message: { id: messageId, channelId, author: { username: 'alice' } }
        }
        client.emit('messageReactionAdd', reaction, { id: userId, bot: false, username: userId })
        await new Promise(resolve => setImmediate(resolve))
      }
      return { sent, star }
    }

    it('should announce once when the same user re-stars a message', async () => {
      const { sent, star } = await setupClient()
      for (let i = 0; i < 5; i++) await star('bob')
      assert.strictEqual(sent.length, 1)
    })

    it('should stay quiet within the channel cooldown', async () => {
      const { sent, star } = await setupClient()
      await star('bob', 'msg-1')
      await star('carol', 'msg-1')
      await star('bob', 'msg-2')
      assert.strictEqual(sent.length, 1)
    })

    it('should announce in a different channel during another channel\'s cooldown', async () => {
      const { sent, star } = await setupClient()
      await star('bob', 'msg-1', 'room-1')
      await star('bob', 'msg-2', 'room-2')
      assert.strictEqual(sent.length, 2)
    })

    it('should announce again once the channel cooldown expires', async () => {
      const { sent, star } = await setupClient()
      const now = mock.method(Date, 'now', () => 1_000_000)
      await star('bob', 'msg-1')
      now.mock.mockImplementation(() => 1_000_000 + 60 * 1000)
      await star('bob', 'msg-2')
      assert.strictEqual(sent.length, 2)
    })

    it('should ignore stars on its own announcements', async () => {
      const { sent, star } = await setupClient()
      const now = mock.method(Date, 'now', () => 1_000_000)
      await star('bob', 'msg-1')
      now.mock.mockImplementation(() => 1_000_000 + 60 * 1000)
      await star('carol', 'announce-1')
      assert.strictEqual(sent.length, 1)
    })
  })
})
