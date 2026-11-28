import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordChannel, DiscordMessage, DiscordReaction } from 'hubot'

import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { runDueJobs, withMessage } from './helpers/fakes.ts'

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

describe('Poll', () => {
  const state = setupRobot('Poll.ts', { owner: 'owner-id' })

  // default user posting from a fake channel
  const inChannel = (channel?: DiscordChannel) => {
    const c = chat(state)
    if (channel) withMessage(c.user, { channel })
    return c
  }
  const member = (id: string, channel: DiscordChannel) => brainUser(state.robot, id, id, { message: { channel } })

  it('only works in discord channels', async () => {
    const { sent, ask } = inChannel()
    await ask('poll should we ship it')
    assert.match(sent[0]!, /only work in Discord channels/)
  })
  it('says no poll has run yet when asked for results first', async () => {
    const { sent, ask } = inChannel()
    await ask('poll results')
    assert.deepStrictEqual(sent, ['No poll has been run in this room yet.'])
  })
  it('posts a yes/no poll and reports results', async () => {
    const { channel, post } = makeChannel({ '👍': 4, '👎': 2 })
    const { sent, ask } = inChannel(channel)
    await ask('poll should we ship it')
    assert.strictEqual(sent[0], 'Poll posted! Vote with the reactions above.')
    assert.deepStrictEqual(post.reacted, ['👍', '👎'])
    assert.strictEqual(post.content[0], '📊 should we ship it')
    await ask('poll results')
    assert.deepStrictEqual(sent.slice(1), ['"should we ship it" — 👍 3 / 👎 1\n(open)'])
  })
  it('posts a multi-option poll with numbered reactions', async () => {
    const { channel, post } = makeChannel({ '1️⃣': 2, '2️⃣': 4, '3️⃣': 1 })
    const { sent, ask } = inChannel(channel)
    await ask('poll lunch? | pizza | tacos | salad')
    assert.strictEqual(post.content[0], '📊 lunch?\n1️⃣ pizza\n2️⃣ tacos\n3️⃣ salad')
    assert.deepStrictEqual(post.reacted, ['1️⃣', '2️⃣', '3️⃣'])
    await ask('poll results')
    assert.strictEqual(sent[1], '"lunch?"\n1️⃣ pizza — 1\n2️⃣ tacos — 3\n3️⃣ salad — 0\n(open)')
  })
  it('rejects bad options and durations', async () => {
    const { sent, ask } = inChannel(makeChannel({}).channel)
    for (const [text, reply] of [
      ['poll q | only', /at least two options/],
      [`poll q | ${Array.from({ length: 11 }, (_, i) => `o${i}`).join(' | ')}`, /at most 10 options/],
      ['poll q | a | | b', /Usage/],
      ['poll 5 eons: q', /don't understand the duration/],
      ['poll 31d: q', /at most 30 days/]
    ] as const) {
      await ask(text)
      assert.match(sent.at(-1)!, reply, text)
    }
  })
  it('auto-closes a timed poll via the client channel and announces the winner', async () => {
    const { channel } = makeChannel({ '1️⃣': 3, '2️⃣': 2 })
    const { robot, sent, ask } = inChannel(channel)
    robot.adapter.client = { channels: { fetch: async (id: string) => (id === 'test-room' ? channel : null) } }
    await ask('poll 1h: tabs or spaces? | tabs | spaces')
    assert.strictEqual(sent[0], 'Poll posted! Vote with the reactions above. It closes in 1h.')
    await runDueJobs(robot, 'poll')
    assert.strictEqual(sent[1], '📊 Poll closed: "tabs or spaces?"\n1️⃣ tabs — 2\n2️⃣ spaces — 1\nWinner: tabs (2 votes).')
    assert.strictEqual(robot.brain.get<{ closed?: boolean }>('poll:test-room')!.closed, true)
  })
  it('notes ties and empty polls when closing', async () => {
    const { sent, ask } = inChannel(makeChannel({ '👍': 2, '👎': 2 }).channel)
    await ask('poll ship it')
    await ask('poll close')
    assert.strictEqual(sent[1], '📊 Poll closed: "ship it" — 👍 1 / 👎 1\nTie between yes and no (1 vote each).')
    const other = member('other-user', makeChannel({ '👍': 1, '👎': 1 }).channel)
    await ask('poll ship it again', { user: other })
    await ask('poll close', { user: other })
    assert.match(sent[3]!, /No votes\.$/)
  })
  it('only lets the creator or owner close, and cancels the timer', async () => {
    const { channel } = makeChannel({ '👍': 2 })
    const { robot, sent, ask } = inChannel(channel)
    await ask('poll 1h: ship it')
    await ask('poll close', { user: member('other', channel) })
    assert.match(sent[1]!, /Only whoever started the poll/)
    const owner = member('owner-id', channel)
    await ask('poll close', { user: owner })
    assert.match(sent[2]!, /^📊 Poll closed/)
    await runDueJobs(robot, 'poll')
    assert.strictEqual(sent.length, 3)
    await ask('poll close', { user: owner })
    assert.strictEqual(sent[3], 'There is no open poll in this room.')
  })
})
