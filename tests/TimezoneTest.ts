import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

// mon 2026-11-16 10:00 utc
const NOW = Date.UTC(2026, 10, 16, 10, 0)

describe('Timezone testing Hubot scripts', () => {
  const state = setupRobot('Timezone.ts', { envVars: ['DEFAULT_TIMEZONE'] })

  it('sets a timezone, canonicalizing the name', async () => {
    const { robot } = state
    mock.method(Date, 'now', () => NOW)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant my timezone is america/new_york', 'test-room')
    assert.equal(sent[0], "Got it, your timezone is America/New_York. It's 5am on Mon, Nov 16 for you.")
    assert.equal(robot.brain.get('tz:user:test-user'), 'America/New_York')
  })
  it('rejects unknown zones', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant my timezone is Mars/Olympus', 'test-room')
    assert.match(sent[0]!, /don't know the timezone "Mars\/Olympus"/)
    assert.equal(robot.brain.get('tz:user:test-user'), null)
  })
  it('shows your timezone, the default when unset', async () => {
    const { robot } = state
    process.env.DEFAULT_TIMEZONE = 'Europe/Paris'
    mock.method(Date, 'now', () => NOW)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant my timezone', 'test-room')
    assert.equal(sent[0], "Your timezone is Europe/Paris. It's 11am on Mon, Nov 16 for you.")
    robot.brain.set('tz:user:test-user', 'Europe/London')
    await robot.adapter.say(user, "@Dumbotheelephant what's my timezone?", 'test-room')
    assert.equal(sent[1], "Your timezone is Europe/London. It's 10am on Mon, Nov 16 for you.")
  })
  it('shows the local time for someone else', async () => {
    const { robot } = state
    mock.method(Date, 'now', () => NOW)
    brainUser(robot, 'bob-id', 'bob')
    brainUser(robot, '12345', 'carol')
    robot.brain.set('tz:user:bob-id', 'Asia/Tokyo')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant time for bob', 'test-room')
    assert.equal(sent[0], "It's 7pm on Mon, Nov 16 for <@bob-id> (Asia/Tokyo).")
    await robot.adapter.say(user, '@Dumbotheelephant what time is it for <@12345>?', 'test-room')
    assert.equal(sent[1], "It's 10am on Mon, Nov 16 for <@12345>.")
    await robot.adapter.say(user, '@Dumbotheelephant time for nobody', 'test-room')
    assert.equal(sent[2], "I don't know anyone called nobody.")
  })
})
