import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, brainUser } from './helpers/setup.mjs'

describe('ReactEmoji testing Hubot scripts', () => {
  const state = setupRobot('ReactEmoji.mjs')

  it('should react with a matching emoji for a single keyword', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.5)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'show me a pug', 'test-room')
    assert.deepStrictEqual(reacted, ['🐕'])
  })
  it('should react to a different keyword category', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'anyone want pizza later', 'test-room')
    assert.deepStrictEqual(reacted, ['🍕'])
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
    await robot.adapter.say(user, 'nothing interesting here', 'test-room')
    assert.deepStrictEqual(reacted, [])
  })
  it('should skip reacting entirely when the skip roll succeeds', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0)
    const reacted = []
    const user = brainUser(robot, 'test-user', 'test user', {
      message: { react: async (emoji) => { reacted.push(emoji) } }
    })
    await robot.adapter.say(user, 'show me a pug', 'test-room')
    assert.deepStrictEqual(reacted, [])
  })
  it('should not error when the raw message has no react method', async () => {
    const { robot } = state
    mock.method(Math, 'random', () => 0.9)
    const user = brainUser(robot, 'test-user', 'test user')
    await assert.doesNotReject(robot.adapter.say(user, 'show me a pug', 'test-room'))
  })
})
