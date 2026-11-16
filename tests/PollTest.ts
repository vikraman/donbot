import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordChannel, DiscordClient, DiscordMessage, DiscordReaction } from 'hubot'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface FakePost {
  message: DiscordMessage
  content: string[]
  reacted: string[]
}

// counts include the bot's own reaction, like discord
const makeChannel = (reactionCounts: Record<string, number>): { channel: DiscordChannel, post: FakePost } => {
  const post: FakePost = { message: null as unknown as DiscordMessage, content: [], reacted: [] }
  post.message = {
    id: 'msg-1',
    reactions: {
      cache: new Map(Object.entries(reactionCounts).map(([emoji, count]) => [
        emoji,
        { partial: false, count, fetch: async () => {} } as unknown as DiscordReaction
      ]))
    },
    react: async (emoji: string) => { post.reacted.push(emoji) }
  } as unknown as DiscordMessage
  const channel = {
    send: async (content: string) => { post.content.push(content); return post.message },
    messages: { fetch: async () => post.message }
  } as unknown as DiscordChannel
  return { channel, post }
}

describe('Poll testing Hubot scripts', () => {
  const state = setupRobot('Poll.ts', { envVars: ['OWNER_USER_ID'] })

  it('should say polls only work in discord channels when there is no raw channel', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant poll should we ship it', 'test-room')
    assert.match(sent[0]!, /only work in Discord channels/)
  })
  it('should post a yes/no poll and report results', async () => {
    const { robot } = state
    const { channel, post } = makeChannel({ '👍': 4, '👎': 2 })
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)

    await robot.adapter.say(user, '@Dumbotheelephant poll should we ship it', 'test-room')
    assert.equal(sent[0], 'Poll posted! Vote with the reactions above.')
    assert.deepEqual(post.reacted, ['👍', '👎'])
    assert.equal(post.content[0], '📊 should we ship it')

    await robot.adapter.say(user, '@Dumbotheelephant poll results', 'test-room')
    assert.equal(sent.length, 2)
    assert.equal(sent[1], '"should we ship it" — 👍 3 / 👎 1\n(open)')
  })
  it('should post a multi-option poll with numbered reactions', async () => {
    const { robot } = state
    const { channel, post } = makeChannel({ '1️⃣': 2, '2️⃣': 4, '3️⃣': 1 })
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)

    await robot.adapter.say(user, '@Dumbotheelephant poll lunch? | pizza | tacos | salad', 'test-room')
    assert.equal(post.content[0], '📊 lunch?\n1️⃣ pizza\n2️⃣ tacos\n3️⃣ salad')
    assert.deepEqual(post.reacted, ['1️⃣', '2️⃣', '3️⃣'])

    await robot.adapter.say(user, '@Dumbotheelephant poll results', 'test-room')
    assert.equal(sent[1], '"lunch?"\n1️⃣ pizza — 1\n2️⃣ tacos — 3\n3️⃣ salad — 0\n(open)')
  })
  it('should reject a single option, too many options, and blank options', async () => {
    const { robot } = state
    const { channel } = makeChannel({})
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant poll q | only', 'test-room')
    await robot.adapter.say(user, `@Dumbotheelephant poll q | ${Array.from({ length: 11 }, (_, i) => `o${i}`).join(' | ')}`, 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant poll q | a | | b', 'test-room')
    assert.match(sent[0]!, /at least two options/)
    assert.match(sent[1]!, /at most 10 options/)
    assert.match(sent[2]!, /Usage/)
  })
  it('should reject bad and overlong durations', async () => {
    const { robot } = state
    const { channel } = makeChannel({})
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant poll 5 fortnights: q', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant poll 31d: q', 'test-room')
    assert.match(sent[0]!, /don't understand the duration/)
    assert.match(sent[1]!, /at most 30 days/)
  })
  it('should auto-close a timed poll via the client channel and announce the winner', async () => {
    const { robot } = state
    const { channel } = makeChannel({ '1️⃣': 3, '2️⃣': 2 })
    robot.adapter.client = { channels: { fetch: async (id: string) => (id === 'test-room' ? channel : null) } } as unknown as DiscordClient
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const sent = collect(robot)

    await robot.adapter.say(user, '@Dumbotheelephant poll 1s: tabs or spaces? | tabs | spaces', 'test-room')
    assert.equal(sent[0], 'Poll posted! Vote with the reactions above. It closes in 1s.')
    await tick(1200)
    assert.equal(sent[1], '📊 Poll closed: "tabs or spaces?"\n1️⃣ tabs — 2\n2️⃣ spaces — 1\nWinner: tabs (2 votes).')
    assert.equal(robot.brain.get<{ closed?: boolean }>('poll:test-room')!.closed, true)
  })
  it('should note ties and empty polls when closing', async () => {
    const { robot } = state
    const tied = makeChannel({ '👍': 2, '👎': 2 })
    const user = brainUser(robot, 'test-user', 'test user', { message: { channel: tied.channel } })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant poll ship it', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant poll close', 'test-room')
    assert.equal(sent[1], '📊 Poll closed: "ship it" — 👍 1 / 👎 1\nTie between yes and no (1 vote each).')

    const empty = makeChannel({ '👍': 1, '👎': 1 })
    const other = brainUser(robot, 'other-user', 'other user', { message: { channel: empty.channel } })
    await robot.adapter.say(other, '@Dumbotheelephant poll ship it again', 'test-room')
    await robot.adapter.say(other, '@Dumbotheelephant poll close', 'test-room')
    assert.match(sent[3]!, /No votes\.$/)
  })
  it('should only let the creator or owner close, and cancel the timer', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'owner-id'
    const { channel } = makeChannel({ '👍': 2 })
    const creator = brainUser(robot, 'test-user', 'test user', { message: { channel } })
    const stranger = brainUser(robot, 'other', 'other', { message: { channel } })
    const owner = brainUser(robot, 'owner-id', 'owner', { message: { channel } })
    const sent = collect(robot)

    await robot.adapter.say(creator, '@Dumbotheelephant poll 1s: ship it', 'test-room')
    await robot.adapter.say(stranger, '@Dumbotheelephant poll close', 'test-room')
    assert.match(sent[1]!, /Only whoever started the poll/)
    await robot.adapter.say(owner, '@Dumbotheelephant poll close', 'test-room')
    assert.match(sent[2]!, /^📊 Poll closed/)
    await tick(1200)
    assert.equal(sent.length, 3)

    await robot.adapter.say(owner, '@Dumbotheelephant poll close', 'test-room')
    assert.equal(sent[3], 'There is no open poll in this room.')
  })
  it('should say no poll has run yet when asked for results first', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant poll results', 'test-room')
    assert.equal(sent.length, 1)
    assert.equal(sent[0], 'No poll has been run in this room yet.')
  })
})
