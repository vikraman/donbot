import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { policyFor } from '../scripts/lib/policy.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { learnMember } from '../scripts/lib/spaces.ts'

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
  it('should leave phrases owned by other scripts alone', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant who is focusing?', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant who is your owner', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant my timezone is Europe/London', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant what time is it for holman', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant my github is holman', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant remind me tomorrow at 9am to check the build is green', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant win the deploy is done', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant focus on why the build is red', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant kudos bob for the fix that is great', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant pep talk bob is sad', 'test-room')
    assert.deepEqual(sent, [])
  })
  it('should not repeat an unknown-user reply back to back', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    for (let i = 0; i < 20; i++) await robot.adapter.say(author, '@Dumbotheelephant nobody is a mystery', 'test-room')
    sent.forEach((line, i) => { if (i) assert.notStrictEqual(line, sent[i - 1]) })
  })
})

describe('Roles in professional servers', () => {
  const state = setupRobot('Roles.ts')

  // a message in guild g1, with or without Manage Roles
  const say = async (id: string, text: string, manageRoles = false) => {
    const user = brainUser(state.robot, id, id === 'u1' ? 'alice' : 'bob')
    const perms = { has: (flag: string) => manageRoles && flag === 'ManageRoles' }
    ;(user as unknown as { message: unknown }).message = { guildId: 'g1', author: { id }, member: { permissions: perms }, channel: { id: 'room', isThread: () => false } }
    await state.robot.adapter.say(user, text, 'room')
  }

  it('needs Manage Roles to set roles, but not to ask', async () => {
    const { robot } = state
    learnMember(robot, 'g:g1', 'u2', 'bob')
    const sent = collect(robot)
    await say('u1', '@Dumbotheelephant bob is a TA')
    assert.strictEqual(sent.at(-1), 'In professional servers, only someone who can manage roles can do that.')
    await say('u1', '@Dumbotheelephant bob is a TA', true)
    assert.strictEqual(sent.at(-1), 'Ok, bob is a TA.')
    await say('u1', '@Dumbotheelephant who is bob')
    assert.strictEqual(sent.at(-1), 'bob is a TA.')
    policyFor(robot).update(d => { d.guilds.g1 = { mode: 'casual', on: [], off: [] } })
    await say('u1', '@Dumbotheelephant bob is not a TA')
    assert.strictEqual(sent.at(-1), 'Ok, bob is no longer a TA.')
  })
})
