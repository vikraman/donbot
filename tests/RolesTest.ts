import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { setRandomSource } from '../scripts/lib/random.ts'

describe('Roles testing Hubot scripts', () => {
  const state = setupRobot('Roles.ts')

  it('should assign a role to a user', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    brainUser(robot, 'holman-id', 'holman')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant holman is an ego surfer', 'test-room')
    assert.strictEqual(sent[0], 'Ok, holman is an ego surfer.')
  })
  it('should report roles when asked who a user is', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    brainUser(robot, 'holman-id', 'holman')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant holman is an ego surfer', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant who is holman', 'test-room')
    assert.strictEqual(sent[1], 'holman is an ego surfer.')
  })
  it('should remove a role from a user', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    brainUser(robot, 'holman-id', 'holman')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant holman is an ego surfer', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant holman is not an ego surfer', 'test-room')
    assert.strictEqual(sent[1], 'Ok, holman is no longer an ego surfer.')
  })
  it('should say it knows nothing about an unknown user', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0 * c))
    const author = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant nobody is a mystery', 'test-room')
    assert.strictEqual(sent[0], "I don't know anything about nobody.")
  })
  it('should vary the response when a known user has no roles', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0 * c))
    const author = brainUser(robot, 'author-id', 'author')
    brainUser(robot, 'holman-id', 'holman')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant who is holman', 'test-room')
    assert.strictEqual(sent[0], 'holman is nothing to me.')
  })
})
