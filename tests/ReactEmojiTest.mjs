import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, brainUser } from './helpers/setup.mjs'
import { SENTIMENT_EMOJI } from '../scripts/ReactEmoji.mjs'

describe('ReactEmoji testing Hubot scripts', () => {
  const state = setupRobot('ReactEmoji.mjs')

  it('should react when at least 2 keywords match', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.5)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'such a cute puppy', 'test-room')
    assert.ok(reacted.length > 0)
    assert.ok(reacted.every(e => ['🥺', '🐶', '🐾', '🙇', '🐯', '🐳'].includes(e)))
  })
  it('should not react when only a single keyword matches', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'anyone want pizza later', 'test-room')
    assert.deepStrictEqual(reacted, [])
  })
  it('should react to a different keyword category', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'want some pizza and cheese', 'test-room')
    assert.ok(reacted.length > 0)
    assert.ok(reacted.every(e => ['🥯', '🍕', '🥪', '🫕', '🪤'].includes(e)))
  })
  it('should react with at most 5 distinct emojis', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'we shipped it, fixed the bug, huge success, love it, amazing work, party time, congrats team', 'test-room')
    assert.ok(reacted.length <= 5)
    assert.ok(reacted.length > 0)
  })
  it('should not react when no keyword matches', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'zzz qwerty blah foobar', 'test-room')
    assert.deepStrictEqual(reacted, [])
  })
  it('should skip reacting entirely when the skip roll succeeds', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'such a cute puppy', 'test-room')
    assert.deepStrictEqual(reacted, [])
  })
  it('should not error when the raw message has no react method', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const user = brainUser(robot, 'test-user', 'test user')
    await assert.doesNotReject(robot.adapter.say(user, 'such a cute puppy', 'test-room'))
  })
  it('should react with a sentiment emoji for strong positive tone with no keyword match', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'what a truly excellent and delightful outcome, everyone performed wonderfully', 'sentiment-room-pos')
    assert.ok(reacted.length > 0)
    assert.ok(reacted.length <= 5)
    for (const emoji of reacted) assert.ok(SENTIMENT_EMOJI.positive.includes(emoji))
  })
  it('should react with a sentiment emoji for strong negative tone with no keyword match', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'this outcome is dreadful and disappointing, everything went horribly wrong', 'sentiment-room-neg')
    assert.ok(reacted.length > 0)
    assert.ok(reacted.length <= 5)
    for (const emoji of reacted) assert.ok(SENTIMENT_EMOJI.negative.includes(emoji))
  })
  it('should populate and cap the per-room tone history', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async () => {} }
    })
    for (let i = 0; i < 12; i++) {
      await robot.adapter.say(user, `just chatting message number ${i}`, 'history-room')
    }
    const history = robot.brain.get('reactemoji:history:history-room')
    assert.strictEqual(history.length, 8)
    for (const entry of history) {
      assert.strictEqual(typeof entry.comparative, 'number')
      assert.strictEqual(typeof entry.ts, 'number')
      assert.strictEqual(Object.keys(entry).length, 2)
    }
  })
  it('should not react to a single negative outlier amid a positive-average room', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    for (let i = 0; i < 5; i++) {
      await robot.adapter.say(user, 'this is wonderful, amazing, so great, love it', 'mixed-mood-room')
    }
    reacted.length = 0
    await robot.adapter.say(user, 'ugh this is dreadful and disappointing', 'mixed-mood-room')
    assert.ok(!reacted.some(e => SENTIMENT_EMOJI.negative.includes(e)))
  })
  it('should not exceed the reaction cap when keywords and sentiment both fire', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'we shipped it, fixed the bug, huge success, love it, amazing work, party time, congrats team, wonderful, incredible, fantastic', 'cap-room')
    assert.ok(reacted.length <= 5)
  })
})
