import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { VOTE_COOLDOWN_MS, MAX_VOTES_PER_WINDOW, VOTE_WINDOW_MS } from '../scripts/Plusplus.ts'

describe('Plusplus testing Hubot scripts', () => {
  const state = setupRobot('Plusplus.ts')

  it('should increment a score on ++', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    assert.strictEqual(sent[0], 'donbot: 1')
  })
  it('should decrement a score on --', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot--', 'test-room')
    assert.strictEqual(sent[0], 'donbot: -1')
  })
  it('should accumulate score across multiple users', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'alice-id', 'alice')
    const bob = brainUser(robot, 'bob-id', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, 'donbot++', 'test-room')
    await robot.adapter.say(bob, 'donbot++', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 2')
  })
  it('should report score via the score command', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant score for donbot', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 1')
  })
  it('should support "points for" as an alternate phrasing', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant points for donbot', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 1')
  })
  it('should ignore repeat votes from the same user within the cooldown', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    for (let i = 0; i < 5; i++) await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, 'DONBOT--', 'other-room')
    await robot.adapter.say(user, '@Dumbotheelephant score for donbot', 'test-room')
    assert.deepStrictEqual(sent, ['donbot: 1', 'donbot: 1'])
  })
  it('should let the same user vote on different things', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    await robot.adapter.say(user, 'coffee++', 'test-room')
    assert.deepStrictEqual(sent, ['donbot: 1', 'coffee: 1'])
  })
  it('should let the same user vote again once the cooldown expires', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    const now = mock.method(Date, 'now', () => 1_000_000)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    now.mock.mockImplementation(() => 1_000_000 + VOTE_COOLDOWN_MS)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    assert.strictEqual(sent[1], 'donbot: 2')
  })
  it('should ignore a user flooding votes across many things', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    for (let i = 0; i < MAX_VOTES_PER_WINDOW + 3; i++) await robot.adapter.say(user, `thing${i}++`, 'test-room')
    assert.strictEqual(sent.length, MAX_VOTES_PER_WINDOW)
  })
  it('should not use up the per-thing cooldown on a vote dropped by the flood limit', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    const now = mock.method(Date, 'now', () => 1_000_000)
    for (let i = 0; i < MAX_VOTES_PER_WINDOW; i++) await robot.adapter.say(user, `thing${i}++`, 'test-room')
    await robot.adapter.say(user, 'donbot++', 'test-room')
    now.mock.mockImplementation(() => 1_000_000 + VOTE_WINDOW_MS)
    await robot.adapter.say(user, 'donbot++', 'test-room')
    assert.strictEqual(sent.at(-1), 'donbot: 1')
  })
  it('should not let one user\'s flood block another user', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'alice-id', 'alice')
    const bob = brainUser(robot, 'bob-id', 'bob')
    const sent = collect(robot)
    for (let i = 0; i < MAX_VOTES_PER_WINDOW + 1; i++) await robot.adapter.say(alice, `thing${i}++`, 'test-room')
    await robot.adapter.say(bob, 'donbot++', 'test-room')
    assert.strictEqual(sent.at(-1), 'donbot: 1')
  })
})
