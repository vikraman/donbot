import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import type { DiscordChannel, DiscordClient, DiscordMessage } from 'hubot'

interface HistoryEntry {
  id: string
  ts: number
  kind: 'bot-message' | 'user-message' | 'reaction-feedback'
  authorId?: string
  valence?: number
}

const fakeChannel = (messagesById: Record<string, { content: string }>): DiscordChannel => ({
  messages: {
    fetch: async (query: string | { message: string, cache?: boolean }) => {
      const message = typeof query === 'string' ? query : query.message
      const found = messagesById[message]
      if (!found) throw new Error('not found')
      return found as unknown as DiscordMessage
    }
  }
} as unknown as DiscordChannel)

describe('History testing Hubot scripts', () => {
  const state = setupRobot('History.ts', { deferLoad: true })

  it('should log a user-message entry for every message with a raw discord id', async () => {
    const { robot } = state
    await state.loadScript()
    const user = brainUser(robot, 'test-user', 'test user', { message: { id: 'msg-1', channel: fakeChannel({}) } })
    await robot.adapter.say(user, 'hello there', 'test-room')
    const entries = robot.brain.get<HistoryEntry[]>('history:test-room')!
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0]!.kind, 'user-message')
    assert.strictEqual(entries[0]!.id, 'msg-1')
    assert.strictEqual(entries[0]!.authorId, 'test-user')
  })

  it('should not log when the raw message has no id', async () => {
    const { robot } = state
    await state.loadScript()
    const user = brainUser(robot, 'test-user', 'test user')
    await robot.adapter.say(user, 'hello there', 'test-room')
    assert.strictEqual(robot.brain.get('history:test-room'), null)
  })

  it('should log positive reaction-feedback on any message', async () => {
    const { robot } = state
    const client = new EventEmitter()
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { id: 'msg-1', channelId: 'test-room', author: { id: 'author-1' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    const entries = robot.brain.get<HistoryEntry[]>('history:test-room')!
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0]!.kind, 'reaction-feedback')
    assert.strictEqual(entries[0]!.valence, 1)
  })

  it('should log negative valence when a positive reaction is removed', async () => {
    const { robot } = state
    const client = new EventEmitter()
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { id: 'msg-1', channelId: 'test-room', author: { id: 'author-1' } }
    }
    client.emit('messageReactionRemove', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    const entries = robot.brain.get<HistoryEntry[]>('history:test-room')!
    assert.strictEqual(entries[0]!.valence, -1)
  })

  it('should ignore reactions from bots and reactions with no valence mapping', async () => {
    const { robot } = state
    const client = new EventEmitter()
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    client.emit('messageReactionAdd', {
      partial: false, emoji: { name: '👍' }, message: { id: 'm', channelId: 'r', author: {} }
    }, { bot: true })
    client.emit('messageReactionAdd', {
      partial: false, emoji: { name: '🤔' }, message: { id: 'm', channelId: 'r', author: {} }
    }, { bot: false })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(robot.brain.get('history:r'), null)
  })

  it('should report the top upvoted message in the room', async () => {
    const { robot } = state
    await state.loadScript()
    const channel = fakeChannel({ 'msg-1': { content: 'great point everyone' } })
    robot.brain.userForId('author-1', { name: 'alice' })
    robot.brain.set('history:test-room', [
      { id: 'msg-1', ts: Date.now(), kind: 'user-message', authorId: 'author-1' },
      { id: 'msg-1', ts: Date.now(), kind: 'reaction-feedback', valence: 1 },
      { id: 'msg-1', ts: Date.now(), kind: 'reaction-feedback', valence: 1 }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top message', 'test-room')
    assert.strictEqual(sent[0], '<@author-1> said: "great point everyone" (+2)')
  })

  it('should say there are no upvoted messages yet', async () => {
    const { robot } = state
    await state.loadScript()
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel: fakeChannel({}) } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top message', 'test-room')
    assert.strictEqual(sent[0], 'No upvoted messages yet.')
  })

  it('should report the most downvoted message', async () => {
    const { robot } = state
    await state.loadScript()
    const channel = fakeChannel({ 'msg-2': { content: 'a bad take' } })
    robot.brain.set('history:down-room', [
      { id: 'msg-2', ts: Date.now(), kind: 'user-message', authorId: 'author-2' },
      { id: 'msg-2', ts: Date.now(), kind: 'reaction-feedback', valence: -1 }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant most downvoted message', 'down-room')
    assert.strictEqual(sent[0], '<@author-2> said: "a bad take" (-1)')
  })

  it('should fall back gracefully when the winning message can no longer be fetched', async () => {
    const { robot } = state
    await state.loadScript()
    const channel = fakeChannel({})
    robot.brain.set('history:gone-room', [
      { id: 'msg-3', ts: Date.now(), kind: 'user-message', authorId: 'author-3' },
      { id: 'msg-3', ts: Date.now(), kind: 'reaction-feedback', valence: 1 }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top message', 'gone-room')
    assert.strictEqual(sent[0], "<@author-3> said something, but I can't find it anymore.")
  })

  it('should list the top N messages by score', async () => {
    const { robot } = state
    await state.loadScript()
    const channel = fakeChannel({
      'a': { content: 'first place take' },
      'b': { content: 'second place take' }
    })
    robot.brain.set('history:top-room', [
      { id: 'a', ts: Date.now(), kind: 'user-message', authorId: 'author-a' },
      { id: 'a', ts: Date.now(), kind: 'reaction-feedback', valence: 1 },
      { id: 'a', ts: Date.now(), kind: 'reaction-feedback', valence: 1 },
      { id: 'a', ts: Date.now(), kind: 'reaction-feedback', valence: 1 },
      { id: 'b', ts: Date.now(), kind: 'user-message', authorId: 'author-b' },
      { id: 'b', ts: Date.now(), kind: 'reaction-feedback', valence: 1 }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top 10 messages', 'top-room')
    assert.strictEqual(sent[0], '1. <@author-a> (+3): "first place take"\n2. <@author-b> (+1): "second place take"')
  })

  it('should scope top message to a time window', async () => {
    const { robot } = state
    await state.loadScript()
    const channel = fakeChannel({ old: { content: 'old news' }, fresh: { content: 'fresh take' } })
    const now = Date.now()
    robot.brain.set('history:windowed-room', [
      { id: 'old', ts: now, kind: 'user-message', authorId: 'author-old' },
      { id: 'old', ts: now - 10 * 24 * 60 * 60 * 1000, kind: 'reaction-feedback', valence: 5 },
      { id: 'fresh', ts: now, kind: 'user-message', authorId: 'author-fresh' },
      { id: 'fresh', ts: now, kind: 'reaction-feedback', valence: 1 }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top message today', 'windowed-room')
    assert.strictEqual(sent[0], '<@author-fresh> said: "fresh take" (+1)')
  })

  it('should support month and year windows', async () => {
    const { robot } = state
    await state.loadScript()
    const channel = fakeChannel({ recent: { content: 'this month' } })
    const now = Date.now()
    robot.brain.set('history:month-room', [
      { id: 'recent', ts: now, kind: 'user-message', authorId: 'author-recent' },
      { id: 'recent', ts: now, kind: 'reaction-feedback', valence: 1 }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top message month', 'month-room')
    assert.strictEqual(sent[0], '<@author-recent> said: "this month" (+1)')
    await robot.adapter.say(user, '@Dumbotheelephant top message year', 'month-room')
    assert.strictEqual(sent[1], '<@author-recent> said: "this month" (+1)')
  })

  it('should scope "last week" to the prior week only, not everything since', async () => {
    const { robot } = state
    await state.loadScript()
    const DAY_MS = 24 * 60 * 60 * 1000
    const channel = fakeChannel({ ancient: { content: 'ancient history' }, priorWeek: { content: 'prior week take' } })
    const now = Date.now()
    robot.brain.set('history:lastweek-room', [
      { id: 'ancient', ts: now, kind: 'user-message', authorId: 'author-ancient' },
      { id: 'ancient', ts: now - 20 * DAY_MS, kind: 'reaction-feedback', valence: 5 },
      { id: 'priorWeek', ts: now, kind: 'user-message', authorId: 'author-prior' },
      { id: 'priorWeek', ts: now - 10 * DAY_MS, kind: 'reaction-feedback', valence: 1 }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top message last week', 'lastweek-room')
    assert.strictEqual(sent[0], '<@author-prior> said: "prior week take" (+1)')
  })

  it('should report the last message from a named user', async () => {
    const { robot } = state
    await state.loadScript()
    const channel = fakeChannel({ 'later-msg': { content: 'second message' } })
    robot.brain.userForId('bob-id', { name: 'bob' })
    robot.brain.set('history:last-room', [
      { id: 'earlier-msg', ts: Date.now() - 120000, kind: 'user-message', authorId: 'bob-id' },
      { id: 'later-msg', ts: Date.now(), kind: 'user-message', authorId: 'bob-id' }
    ])
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant last message from bob', 'last-room')
    assert.strictEqual(sent[0], '<@bob-id> said: "second message" (just now)')
  })

  it('should say it does not know an unrecognized user for "last message from"', async () => {
    const { robot } = state
    await state.loadScript()
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel: fakeChannel({}) } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant last message from nobody-known', 'test-room')
    assert.strictEqual(sent[0], "I don't know anything about nobody-known.")
  })

  it('should report the most active user', async () => {
    const { robot } = state
    await state.loadScript()
    robot.brain.set('history:active-room', [
      { id: 'm1', ts: Date.now(), kind: 'user-message', authorId: 'alice-id' },
      { id: 'm2', ts: Date.now(), kind: 'user-message', authorId: 'alice-id' },
      { id: 'm3', ts: Date.now(), kind: 'user-message', authorId: 'bob-id' }
    ])
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant most active user', 'active-room')
    assert.strictEqual(sent[0], '<@alice-id> with 2 messages.')
  })

  it('should report the least active user', async () => {
    const { robot } = state
    await state.loadScript()
    robot.brain.set('history:active-room2', [
      { id: 'm1', ts: Date.now(), kind: 'user-message', authorId: 'alice-id' },
      { id: 'm2', ts: Date.now(), kind: 'user-message', authorId: 'alice-id' },
      { id: 'm3', ts: Date.now(), kind: 'user-message', authorId: 'bob-id' }
    ])
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant least active user', 'active-room2')
    assert.strictEqual(sent[0], '<@bob-id> with 1 message.')
  })

  it('should say when no messages are tracked yet for active-user queries', async () => {
    const { robot } = state
    await state.loadScript()
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant most active user', 'empty-room')
    assert.strictEqual(sent[0], 'No messages tracked in this room yet.')
  })

  it('should scope most active user to a time window', async () => {
    const { robot } = state
    await state.loadScript()
    const DAY_MS = 24 * 60 * 60 * 1000
    const now = Date.now()
    robot.brain.set('history:active-windowed', [
      { id: 'old1', ts: now - 10 * DAY_MS, kind: 'user-message', authorId: 'alice-id' },
      { id: 'old2', ts: now - 10 * DAY_MS, kind: 'user-message', authorId: 'alice-id' },
      { id: 'old3', ts: now - 10 * DAY_MS, kind: 'user-message', authorId: 'alice-id' },
      { id: 'recent1', ts: now, kind: 'user-message', authorId: 'bob-id' }
    ])
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant most active user today', 'active-windowed')
    assert.strictEqual(sent[0], '<@bob-id> with 1 message.')
  })

  it('should list the top N active users by message count', async () => {
    const { robot } = state
    await state.loadScript()
    robot.brain.set('history:active-top', [
      { id: 'm1', ts: Date.now(), kind: 'user-message', authorId: 'alice-id' },
      { id: 'm2', ts: Date.now(), kind: 'user-message', authorId: 'alice-id' },
      { id: 'm3', ts: Date.now(), kind: 'user-message', authorId: 'bob-id' }
    ])
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top 10 active users', 'active-top')
    assert.strictEqual(sent[0], '1. <@alice-id>: 2\n2. <@bob-id>: 1')
  })
})
