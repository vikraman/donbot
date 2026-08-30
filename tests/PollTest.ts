import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordChannel, DiscordMessage, DiscordReaction } from 'hubot'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const makeFakeMessage = (id: string, reactionCounts: Record<string, number>): DiscordMessage =>
  ({
    id,
    reactions: {
      cache: new Map(Object.entries(reactionCounts).map(([emoji, count]) => [
        emoji,
        { partial: false, count, fetch: async () => {} } as unknown as DiscordReaction
      ]))
    }
  }) as unknown as DiscordMessage

describe('Poll testing Hubot scripts', () => {
  const state = setupRobot('Poll.ts')

  it('should say polls only work in discord channels when there is no raw channel', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant poll should we ship it', 'test-room')
    assert.match(sent[0]!, /only work in Discord channels/)
  })
  it('should post a poll and report results from a discord-like channel', async () => {
    const { robot } = state
    const posted = makeFakeMessage('msg-1', { '👍': 4, '👎': 2 })
    posted.react = (async () => {}) as unknown as DiscordMessage['react']
    const channel: DiscordChannel = { send: async () => posted, messages: { fetch: async () => posted } }
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)

    await robot.adapter.say(user, '@Dumbotheelephant poll should we ship it', 'test-room')
    assert.match(sent[0]!, /Poll posted/)

    await robot.adapter.say(user, '@Dumbotheelephant poll results', 'test-room')
    assert.strictEqual(sent[1], '"should we ship it" — 👍 3 / 👎 1')
  })
  it('should say no poll has run yet when asked for results first', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant poll results', 'test-room')
    assert.strictEqual(sent[0], 'No poll has been run in this room yet.')
  })
})
