import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('Remind testing Hubot scripts', () => {
  const state = setupRobot('Remind.ts')

  it('should acknowledge setting a reminder', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should support the "set a reminder for" alternate phrasing', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant set a reminder for 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should reject an unknown unit', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 fortnights to stretch', 'test-room')
    assert.match(sent[0]!, /don't understand the unit/)
  })
  it('should fire the reminder after the delay elapses', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 1 seconds to stretch', 'test-room')
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.strictEqual(sent[1], '<@test-user> reminder: stretch')
  })
  it('should support "to <message> in <N> <unit>" phrasing', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me to stretch in 5 minutes', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should set a reminder for another user by name', async () => {
    const { robot } = state
    brainUser(robot, 'bob-id', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind <@bob-id> in 5 minutes.")
  })
  it('should set a reminder for another user via a Discord mention', async () => {
    const { robot } = state
    brainUser(robot, '12345', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind <@12345> in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind <@12345> in 5 minutes.")
  })
  it('should notify the target user, not the sender, when the reminder fires', async () => {
    const { robot } = state
    brainUser(robot, 'bob-id', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind bob to stretch in 1 seconds', 'test-room')
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.strictEqual(sent[1], '<@bob-id> reminder: stretch')
  })
  it('should fall back to a plain name when the target has no known Discord id', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind nobody-known in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind @nobody-known in 5 minutes.")
  })
  it('should say there are no pending reminders when the room has none', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant list reminders', 'test-room')
    assert.strictEqual(sent[0], 'No pending reminders in this room.')
  })
  it('should list pending reminders in the current room', async () => {
    const { robot } = state
    brainUser(robot, 'bob-id', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 1 hour to review PR', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind list', 'test-room')
    assert.match(sent[2]!, /for <@test-user>: stretch/)
    assert.match(sent[2]!, /for <@bob-id>: review PR/)
  })
  it('should only list the requester\'s own reminders with "my reminders"', async () => {
    const { robot } = state
    brainUser(robot, 'bob-id', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 1 hour to review PR', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant my reminders', 'test-room')
    assert.match(sent[2]!, /for <@test-user>: stretch/)
    assert.doesNotMatch(sent[2]!, /bob/)
  })
  it('should not list reminders from other rooms', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'other-room')
    await robot.adapter.say(user, '@Dumbotheelephant list reminders', 'test-room')
    assert.strictEqual(sent[1], 'No pending reminders in this room.')
  })
})
