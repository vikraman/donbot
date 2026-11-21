import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordChannel, DiscordMessage } from 'hubot'

import { setupRobot, chat, inGuild } from './helpers/setup.ts'
import { fakeClient, react, settle, withMessage } from './helpers/fakes.ts'

interface HistoryEntry {
  id: string
  ts: number
  kind: 'bot-message' | 'user-message' | 'reaction-feedback'
  authorId?: string
  valence?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

const fakeChannel = (messagesById: Record<string, string>): DiscordChannel => ({
  messages: {
    fetch: async (query: string | { message: string, cache?: boolean }) => {
      const id = typeof query === 'string' ? query : query.message
      if (!(id in messagesById)) throw new Error('not found')
      return { content: messagesById[id] } as unknown as DiscordMessage
    }
  }
} as unknown as DiscordChannel)

// history entries, ago in days
const msg = (id: string, authorId: string, ago = 0): HistoryEntry => ({ id, ts: Date.now() - ago * DAY_MS, kind: 'user-message', authorId })
const vote = (id: string, valence = 1, ago = 0): HistoryEntry => ({ id, ts: Date.now() - ago * DAY_MS, kind: 'reaction-feedback', valence })

describe('History', () => {
  const state = setupRobot('History.ts', { deferLoad: true })

  const entries = (room: string) => state.robot.brain.get<HistoryEntry[]>(`history:${room}`)

  it('logs a user message with a raw discord id, and none without', async () => {
    await state.loadScript()
    const { user, say } = chat(state)
    await say('no raw message')
    assert.strictEqual(entries('test-room'), null)
    withMessage(user, { id: 'msg-1', channel: fakeChannel({}) })
    await say('hello there')
    assert.deepStrictEqual(entries('test-room')!.map(e => [e.kind, e.id, e.authorId]), [['user-message', 'msg-1', 'test-user']])
  })

  describe('reactions', () => {
    const on = { id: 'msg-1', author: { id: 'author-1' } }

    it('logs positive feedback on add and negative on removal', async () => {
      const client = await fakeClient(state)
      await react(client, '👍', { room: 'test-room', message: on })
      client.emit('messageReactionRemove', { partial: false, emoji: { name: '👍' }, message: { channelId: 'test-room', ...on } }, { bot: false, username: 'bob' })
      await settle()
      assert.deepStrictEqual(entries('test-room')!.map(e => [e.kind, e.valence]), [['reaction-feedback', 1], ['reaction-feedback', -1]])
    })

    it('logs nothing where history tracking is off', async () => {
      const client = await fakeClient(state)
      inGuild(state.robot, 'g1', ['pro-room'])
      await react(client, '👍', { room: 'pro-room', message: on })
      assert.strictEqual(entries('pro-room'), null)
    })

    it('ignores bots and emoji with no valence', async () => {
      const client = await fakeClient(state)
      await react(client, '👍', { room: 'r', bot: true, message: on })
      await react(client, '🤔', { room: 'r', message: on })
      assert.strictEqual(entries('r'), null)
    })
  })

  // seed a room, ask once, return the reply
  const query = async (text: string, history: HistoryEntry[], messages: Record<string, string> = {}) => {
    await state.loadScript()
    const { robot, user, ask, sent } = chat(state)
    robot.brain.set('history:q-room', history)
    withMessage(user, { channel: fakeChannel(messages) })
    await ask(text, { room: 'q-room' })
    return sent[0]
  }

  const cases: [string, string, HistoryEntry[], Record<string, string>, string][] = [
    ['reports the top upvoted message', 'top message',
      [msg('m1', 'author-1'), vote('m1'), vote('m1')], { m1: 'great point everyone' },
      '<@author-1> said: "great point everyone" (+2)'],
    ['says when nothing is upvoted', 'top message', [], {}, 'No upvoted messages yet.'],
    ['reports the most downvoted message', 'most downvoted message',
      [msg('m2', 'author-2'), vote('m2', -1)], { m2: 'a bad take' },
      '<@author-2> said: "a bad take" (-1)'],
    ['falls back when the winner is gone', 'top message',
      [msg('m3', 'author-3'), vote('m3')], {},
      "<@author-3> said something, but I can't find it anymore."],
    ['lists the top n messages', 'top 10 messages',
      [msg('a', 'author-a'), vote('a'), vote('a'), vote('a'), msg('b', 'author-b'), vote('b')], { a: 'first place take', b: 'second place take' },
      '1. <@author-a> (+3): "first place take"\n2. <@author-b> (+1): "second place take"'],
    ['scopes top message to today', 'top message today',
      [msg('old', 'author-old'), vote('old', 5, 10), msg('fresh', 'author-fresh'), vote('fresh')], { old: 'old news', fresh: 'fresh take' },
      '<@author-fresh> said: "fresh take" (+1)'],
    ['supports month windows', 'top message month',
      [msg('r', 'author-recent'), vote('r')], { r: 'this month' }, '<@author-recent> said: "this month" (+1)'],
    ['supports year windows', 'top message year',
      [msg('r', 'author-recent'), vote('r')], { r: 'this month' }, '<@author-recent> said: "this month" (+1)'],
    ['scopes last week to the prior week only', 'top message last week',
      [msg('ancient', 'author-ancient'), vote('ancient', 5, 20), msg('prior', 'author-prior'), vote('prior', 1, 10)], { ancient: 'ancient history', prior: 'prior week take' },
      '<@author-prior> said: "prior week take" (+1)'],
    ['reports the last message from a user', 'last message from bob',
      [msg('earlier', 'bob-id', 0.01), msg('later', 'bob-id')], { later: 'second message' },
      '<@bob-id> said: "second message" (just now)'],
    ['says it does not know an unknown user', 'last message from nobody-known', [], {}, "I don't know anything about nobody-known."],
    ['reports the most active user', 'most active user',
      [msg('m1', 'alice-id'), msg('m2', 'alice-id'), msg('m3', 'bob-id')], {}, '<@alice-id> with 2 messages.'],
    ['reports the least active user', 'least active user',
      [msg('m1', 'alice-id'), msg('m2', 'alice-id'), msg('m3', 'bob-id')], {}, '<@bob-id> with 1 message.'],
    ['says when no messages are tracked', 'most active user', [], {}, 'No messages tracked in this room yet.'],
    ['scopes most active user to a window', 'most active user today',
      [msg('o1', 'alice-id', 10), msg('o2', 'alice-id', 10), msg('o3', 'alice-id', 10), msg('r1', 'bob-id')], {}, '<@bob-id> with 1 message.'],
    ['lists the top n active users', 'top 10 active users',
      [msg('m1', 'alice-id'), msg('m2', 'alice-id'), msg('m3', 'bob-id')], {}, '1. <@alice-id>: 2\n2. <@bob-id>: 1']
  ]

  for (const [name, text, history, messages, expected] of cases) {
    it(name, async () => {
      if (text.includes('bob')) state.robot.brain.userForId('bob-id', { name: 'bob' })
      assert.strictEqual(await query(text, history, messages), expected)
    })
  }
})
