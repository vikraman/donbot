import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat, brainUser, sendReturnsIds, inGuild } from './helpers/setup.ts'
import { fakeClient, react } from './helpers/fakes.ts'

import { setRandomSource } from '../scripts/lib/random.ts'
import { ENTHUSIASTIC_LINES } from '../scripts/Praise.ts'

const BOT = { user: { id: 'bot-id' } }
const onBot = (extra: Record<string, unknown> = {}) => ({ author: { id: 'bot-id' }, ...extra })

describe('Praise', () => {
  const state = setupRobot('Praise.ts')

  for (const text of ['cookie', 'good bot', 'good job', 'good boy donbot', 'thanks', 'thank you']) {
    it(`answers "${text}"`, async () => {
      const { ask, sent } = chat(state)
      await ask(text)
      assert.strictEqual(sent.length, 1)
      assert.ok(sent[0]!.length > 0)
    })
  }

  it('tracks and reports the praise count', async () => {
    const { ask, sent } = chat(state)
    await ask('praise count')
    await ask('cookie')
    await ask('good bot')
    await ask('praise count')
    assert.strictEqual(sent[0], "I've been praised 0 times.")
    assert.strictEqual(sent[3], "I've been praised 2 times.")
  })

  it('lists who praised it, ranked by count', async () => {
    const { robot, ask, sent } = chat(state)
    await ask('who praised you')
    assert.strictEqual(sent[0], 'Nobody. Real quiet out there.')
    const alice = brainUser(robot, 'alice-id', 'alice')
    const bob = brainUser(robot, 'bob-id', 'bob')
    await ask('cookie', { user: alice })
    await ask('cookie', { user: bob })
    await ask('good bot', { user: bob })
    await ask('who praised you', { user: alice })
    assert.strictEqual(sent.at(-1), '<@bob-id>: 2 times\n<@alice-id>: once')
  })

  it('picks from the enthusiastic pool for an effusive compliment', async () => {
    const { ask, sent } = chat(state)
    for (let i = 0; i < 10; i++) await ask('what a fantastic, brilliant, outstanding effort, good job!!!')
    for (const line of sent) assert.ok((ENTHUSIASTIC_LINES as readonly string[]).includes(line), line)
  })

  it('picks from the full pool for a flat "thanks"', async () => {
    setRandomSource(() => 0)
    const { ask, sent } = chat(state)
    await ask('thanks')
    assert.ok(!(ENTHUSIASTIC_LINES as readonly string[]).includes(sent[0]!))
  })
})

describe('Praise reactions', () => {
  const state = setupRobot('Praise.ts', { deferLoad: true })

  it('loads without a discord client', async () => {
    await assert.doesNotReject(state.loadScript())
  })

  it('counts a praise emoji on its own message', async () => {
    const client = await fakeClient(state, BOT)
    const { sent } = chat(state)
    await react(client, '👍', { message: onBot() })
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(state.robot.brain.get('praise:count'), 1)
  })

  for (const [name, emoji, opts] of [
    ['messages from others', '👍', { message: { author: { id: 'someone-else' } } }],
    ['bots', '👍', { bot: true, message: onBot() }],
    ['other emoji', '😢', { message: onBot() }]
  ] as const) {
    it(`ignores reactions from ${name}`, async () => {
      const client = await fakeClient(state, BOT)
      const { sent } = chat(state)
      await react(client, emoji, opts)
      assert.deepStrictEqual(sent, [])
    })
  }

  it('neither counts nor replies in professional servers', async () => {
    const client = await fakeClient(state, BOT)
    inGuild(state.robot, 'g1', ['pro-room'])
    const { sent } = chat(state)
    await react(client, '👍', { room: 'pro-room', message: onBot() })
    assert.deepStrictEqual(sent, [])
    assert.strictEqual(state.robot.brain.get('praise:count'), null)
  })

  it('counts each user once per message, replying within the guard', async () => {
    sendReturnsIds(state.robot, 'ack')
    const client = await fakeClient(state, BOT)
    const { robot, ask, sent } = chat(state, { id: 'bob', name: 'bob' })
    const fan = (id: string, msg: string, emoji = '👍', room = 'room-1') => react(client, emoji, { by: id, user: { id }, room, message: onBot({ id: msg }) })
    await fan('bob', 'msg-1')
    await fan('bob', 'msg-1')
    await fan('bob', 'msg-1', '🔥')
    await fan('alice', 'msg-1')
    await fan('bob', 'msg-2')
    // counted, but no reply in cooldown
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(robot.brain.get('praise:count'), 3)
    // acks of text compliments are its own
    await ask('good bot', { room: 'room-2' })
    await fan('carol', 'ack-2', '👍', 'room-2')
    assert.strictEqual(sent.length, 2)
    assert.strictEqual(robot.brain.get('praise:count'), 5)
  })

  it('logs instead of crashing when it cannot reply to a reaction', async () => {
    const client = await fakeClient(state, BOT)
    mock.method(state.robot, 'messageRoom', async () => { throw new Error('Missing Access') })
    const warn = mock.method(state.robot.logger, 'warn', () => {})
    await react(client, '👍', { room: 'room-locked', user: { id: 'fan' }, message: onBot({ id: 'm-locked' }) })
    assert.ok(warn.mock.calls.some(c => /couldn't reply in room-locked/.test(String(c.arguments[0]))))
  })
})
