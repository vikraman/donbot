import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import type { DiscordClient } from 'hubot'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { setRandomSource } from '../scripts/lib/random.ts'

const ENTHUSIASTIC_LINES = [
  "That's more like it. Keep it coming.",
  "See, was that so hard? A little respect.",
  "I'll add that to my tab. You owe me plenty more.",
  "I do good work. Glad somebody noticed."
]

describe('Praise testing Hubot scripts', () => {
  const state = setupRobot('Praise.ts')

  it('should respond to "cookie"', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant cookie', 'test-room')
    assert.strictEqual(sent.length, 1)
    assert.ok(sent[0]!.length > 0)
  })

  it('should respond to "good bot"', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant good bot', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should respond to "good job"', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant good job', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should respond to "good boy donbot"', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant good boy donbot', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should track and report the praise count', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant cookie', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant good bot', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant praise count', 'test-room')
    assert.strictEqual(sent[2], "I've been praised 2 times.")
  })

  it('should say it has never been praised when the count is zero', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant praise count', 'test-room')
    assert.strictEqual(sent[0], "I've been praised 0 times.")
  })

  it('should respond to "thanks"', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant thanks', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should respond to "thank you"', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant thank you', 'test-room')
    assert.strictEqual(sent.length, 1)
  })

  it('should say nobody has praised it when asked "who praised you" with no history', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant who praised you', 'test-room')
    assert.strictEqual(sent[0], 'Nobody. Real quiet out there.')
  })

  it('should list who praised it and how often, ranked by count', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'alice-id', 'alice')
    const bob = brainUser(robot, 'bob-id', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant cookie', 'test-room')
    await robot.adapter.say(bob, '@Dumbotheelephant cookie', 'test-room')
    await robot.adapter.say(bob, '@Dumbotheelephant good bot', 'test-room')
    await robot.adapter.say(alice, '@Dumbotheelephant who praised you', 'test-room')
    assert.strictEqual(sent.at(-1), '<@bob-id>: 2 times\n<@alice-id>: once')
  })

  it('should not error when there is no discord-like client for reactions', async () => {
    // already loaded in beforeEach with no client set; loading again should not throw
    await assert.doesNotReject(state.loadScript())
  })

  it('should count a praise emoji reaction on the bot\'s own message', async () => {
    const { robot } = state
    const client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { id: 'bot-id' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 1)
  })

  it('should ignore praise emoji reactions on messages from other users', async () => {
    const { robot } = state
    const client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { id: 'someone-else' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })

  it('should ignore reactions from bots', async () => {
    const { robot } = state
    const client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: { channelId: 'room-1', author: { id: 'bot-id' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: true, username: 'otherbot' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })

  it('should pick from the enthusiastic pool for a strongly enthusiastic compliment', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    for (let i = 0; i < 10; i++) {
      await robot.adapter.say(user, '@Dumbotheelephant what a fantastic, brilliant, outstanding effort, good job!!!', 'test-room')
    }
    for (const line of sent) assert.ok(ENTHUSIASTIC_LINES.includes(line))
  })

  it('should still pick from the full pool for a flat "thanks"', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0 * c))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant thanks', 'test-room')
    assert.strictEqual(sent[0], "Heh, yeah, I know I'm good.")
  })

  it('should ignore non-praise emoji reactions', async () => {
    const { robot } = state
    const client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()

    const sent = collect(robot)

    const reaction = {
      partial: false,
      emoji: { name: '😢' },
      message: { channelId: 'room-1', author: { id: 'bot-id' } }
    }
    client.emit('messageReactionAdd', reaction, { bot: false, username: 'bob' })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(sent.length, 0)
  })
})
