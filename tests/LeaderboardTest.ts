import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { setRandomSource } from '../scripts/lib/random.ts'

describe('Leaderboard testing Hubot scripts', () => {
  const state = setupRobot('Leaderboard.ts')

  it('should say there are no scores yet', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
    assert.strictEqual(sent[0], 'No scores yet.')
  })
  it('should list scores in descending order without commentary', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0.9 * c))
    robot.brain.set('plusplus:tacos', 5)
    robot.brain.set('plusplus:pizza', 10)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
    assert.strictEqual(sent[0], '1. pizza: 10\n2. tacos: 5')
  })
  it('should support "top scores" as an alternate phrasing', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0.9 * c))
    robot.brain.set('plusplus:tacos', 5)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant top scores', 'test-room')
    assert.strictEqual(sent[0], '1. tacos: 5')
  })
  it('should include commentary about the top scorer when the roll succeeds', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0 * c))
    robot.brain.set('plusplus:tacos', 5)
    robot.brain.set('plusplus:pizza', 10)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
    assert.match(sent[0]!, /pizza is untouchable right now\./)
  })
})
