import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('Seen testing Hubot scripts', () => {
  const state = setupRobot('Seen.ts', { envVars: ['OWNER_USER_ID'] })

  it('should say it has not seen an unknown user', async () => {
    const { robot } = state
    const user = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant seen nobody', 'test-room')
    assert.strictEqual(sent[0], "I don't know anything about nobody.")
  })
  it('should report the last seen time for a user after they speak', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    const holman = brainUser(robot, 'holman-id', 'holman')
    const sent = collect(robot)
    await robot.adapter.say(holman, 'hello there', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant seen holman', 'test-room')
    assert.match(sent[0]!, /^<@holman-id> was last seen /)
  })
  it('should support "have you seen" as an alternate phrasing', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    const holman = brainUser(robot, 'holman-id', 'holman')
    const sent = collect(robot)
    await robot.adapter.say(holman, 'hello there', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant have you seen holman', 'test-room')
    assert.match(sent[0]!, /^<@holman-id> was last seen /)
  })
  it('should register a speaker in the brain just from them talking, with no prior registration', async () => {
    const { robot } = state
    const stranger = { id: 'stranger-id', name: 'stranger' }
    await robot.adapter.say(stranger, 'hello there', 'test-room')
    assert.strictEqual(robot.brain.data.users['stranger-id']!.name, 'stranger')
  })
  it('should update a known user\'s name in the brain when it changes', async () => {
    const { robot } = state
    const user = { id: 'renamed-id', name: 'oldname' }
    await robot.adapter.say(user, 'hello there', 'test-room')
    user.name = 'newname'
    await robot.adapter.say(user, 'hello again', 'test-room')
    assert.strictEqual(robot.brain.data.users['renamed-id']!.name, 'newname')
  })
  it('should say it knows no one yet when asked "who do you know" with no history', async () => {
    const { robot } = state
    const sent = collect(robot)
    const author = brainUser(robot, 'author-id', 'author')
    await robot.adapter.say(author, '@Dumbotheelephant who do you know', 'test-room')
    assert.strictEqual(sent[0], `I know 1 person: author`)
  })
  it('should list everyone the bot has seen talk with "who do you know"', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    const holman = { id: 'holman-id', name: 'holman' }
    const sent = collect(robot)
    await robot.adapter.say(holman, 'hello there', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant who do you know', 'test-room')
    assert.match(sent[0]!, /^I know 2 people: /)
    assert.match(sent[0]!, /\bauthor\b/)
    assert.match(sent[0]!, /\bholman\b/)
  })
  it('should say it has no owner configured when OWNER_USER_ID is unset', async () => {
    const { robot } = state
    const author = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant who is your owner', 'test-room')
    assert.strictEqual(sent[0], "I don't have an owner configured.")
  })
  it('should say the owner is unknown when configured but never seen talk', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'owner-id'
    const author = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    await robot.adapter.say(author, '@Dumbotheelephant who is your owner', 'test-room')
    assert.strictEqual(sent[0], "My owner hasn't said anything yet, so I don't know their name.")
  })
  it('should report the owner\'s name once known', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = { id: 'owner-id', name: 'vikraman' }
    const author = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    await robot.adapter.say(owner, 'hello', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant who is your owner', 'test-room')
    assert.strictEqual(sent[0], 'vikraman owns me.')
  })
  it('should support "who made you" as an alternate phrasing', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'owner-id'
    const owner = { id: 'owner-id', name: 'vikraman' }
    const author = brainUser(robot, 'author-id', 'author')
    const sent = collect(robot)
    await robot.adapter.say(owner, 'hello', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant who made you', 'test-room')
    assert.strictEqual(sent[0], 'vikraman owns me.')
  })
})
