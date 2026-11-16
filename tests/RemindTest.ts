import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { parseRequest } from '../scripts/Remind.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

// mon 2026-11-16 10:00 utc
const NOW = Date.UTC(2026, 10, 16, 10, 0)
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('Remind request parsing', () => {
  it('splits time-first and time-last phrasings', () => {
    assert.deepEqual(parseRequest('in 5 minutes to stretch', 'UTC', NOW)?.message, 'stretch')
    assert.deepEqual(parseRequest('to stretch in 5 minutes', 'UTC', NOW)?.message, 'stretch')
    assert.deepEqual(parseRequest('at 3pm to call mom', 'UTC', NOW)?.message, 'call mom')
    assert.deepEqual(parseRequest('to call mom at 3pm', 'UTC', NOW)?.message, 'call mom')
  })
  it('keeps " to " inside the message', () => {
    const parsed = parseRequest('tomorrow at 9am to talk to bob about moving to rust', 'UTC', NOW)
    assert.equal(parsed?.message, 'talk to bob about moving to rust')
    assert.equal(parsed?.when.at, Date.UTC(2026, 10, 17, 9, 0))
    assert.equal(parseRequest('to talk to bob on friday at 10', 'UTC', NOW)?.message, 'talk to bob')
  })
  it('parses recurring requests', () => {
    const parsed = parseRequest('every weekday at 9am to post standup', 'UTC', NOW)
    assert.equal(parsed?.message, 'post standup')
    assert.equal(parsed?.when.repeat?.kind, 'weekly')
  })
  it('rejects requests without a time', () => {
    assert.equal(parseRequest('to stretch', 'UTC', NOW), undefined)
    assert.equal(parseRequest('sometime to stretch', 'UTC', NOW), undefined)
  })
})

describe('Remind testing Hubot scripts', () => {
  const state = setupRobot('Remind.ts', { envVars: ['OWNER_USER_ID', 'DEFAULT_TIMEZONE'] })

  it('acknowledges a relative reminder', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    assert.equal(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('names the timezone only when it is not the default', async () => {
    const { robot } = state
    mock.method(Date, 'now', () => NOW)
    robot.brain.set('tz:user:test-user', 'Asia/Tokyo')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me to call mom at 3pm', 'test-room')
    assert.equal(sent[0], "Ok, I'll remind you tomorrow at 3pm (Asia/Tokyo).")
  })
  it('acknowledges a recurring reminder', async () => {
    const { robot } = state
    mock.method(Date, 'now', () => NOW)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me every weekday at 9am to post standup', 'test-room')
    assert.equal(sent[0], "Ok, I'll remind you every weekday at 9am.")
    await robot.adapter.say(user, '@Dumbotheelephant remind me every 2 hours to drink water', 'test-room')
    assert.equal(sent[1], "Ok, I'll remind you every 2 hours.")
  })
  it('uses DEFAULT_TIMEZONE when the requester has none', async () => {
    const { robot } = state
    process.env.DEFAULT_TIMEZONE = 'America/New_York'
    mock.method(Date, 'now', () => NOW)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me at 3pm to leave', 'test-room')
    assert.equal(sent[0], "Ok, I'll remind you today at 3pm.")
    assert.equal(robot.brain.get<{ tz: string }[]>('schedule:remind')![0]!.tz, 'America/New_York')
  })
  it('explains the formats when it cannot parse the time', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 fortnights to stretch', 'test-room')
    assert.match(sent[0]!, /couldn't tell when/)
    assert.match(sent[0]!, /every weekday at 9am/)
  })
  it('fires the reminder when due', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 1 second to stretch', 'test-room')
    await tick(1100)
    assert.equal(sent[1], '<@test-user> reminder: stretch')
    assert.deepEqual(robot.brain.get('schedule:remind'), [])
  })
  it('notifies the target, by name or mention', async () => {
    const { robot } = state
    brainUser(robot, 'bob-id', 'bob')
    brainUser(robot, '12345', 'carol')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind bob to stretch in 1 second', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind <@12345> in 5 minutes to review', 'test-room')
    assert.equal(sent[0], "Ok, I'll remind <@bob-id> in 1 second.")
    assert.equal(sent[1], "Ok, I'll remind <@12345> in 5 minutes.")
    await tick(1100)
    assert.equal(sent[2], '<@bob-id> reminder: stretch')
  })
  it('falls back to a plain name for unknown targets', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind nobody-known in 5 minutes to stretch', 'test-room')
    assert.equal(sent[0], "Ok, I'll remind @nobody-known in 5 minutes.")
  })
  it('lists reminders in this room, numbered by due time', async () => {
    const { robot } = state
    mock.method(Date, 'now', () => NOW)
    brainUser(robot, 'bob-id', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 1 hour to review PR', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind me every weekday at 9am to post standup', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to elsewhere', 'other-room')
    await robot.adapter.say(user, '@Dumbotheelephant list reminders', 'test-room')
    assert.equal(sent[4], [
      '1. today at 10:05am for <@test-user>: stretch',
      '2. today at 11am for <@bob-id>: review PR',
      '3. tomorrow at 9am, every weekday at 9am for <@test-user>: post standup'
    ].join('\n'))
  })
  it('shows only your reminders, keeping room numbers', async () => {
    const { robot } = state
    mock.method(Date, 'now', () => NOW)
    brainUser(robot, 'bob-id', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 1 minute to review PR', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant my reminders', 'test-room')
    assert.equal(sent[2], '2. today at 10:05am for <@test-user>: stretch')
  })
  it('says when there is nothing pending', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant list reminders', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant my reminders', 'test-room')
    assert.equal(sent[0], 'No pending reminders in this room.')
    assert.equal(sent[1], "You don't have any pending reminders.")
  })
  it('cancels a reminder by number', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant cancel reminder 1', 'test-room')
    assert.equal(sent[1], 'Cancelled reminder for <@test-user>: stretch')
    assert.deepEqual(robot.brain.get('schedule:remind'), [])
    await robot.adapter.say(user, '@Dumbotheelephant forget reminder 1', 'test-room')
    assert.match(sent[2]!, /no reminder 1 here/)
  })
  it('only lets the setter, target or owner cancel', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'owner-id'
    brainUser(robot, 'bob-id', 'bob')
    const user = brainUser(robot, 'test-user', 'test user')
    const eve = brainUser(robot, 'eve-id', 'eve')
    const owner = brainUser(robot, 'owner-id', 'owner')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(eve, '@Dumbotheelephant cancel reminder 1', 'test-room')
    assert.match(sent[1]!, /Only the person/)
    await robot.adapter.say(owner, '@Dumbotheelephant cancel reminder 1', 'test-room')
    assert.match(sent[2]!, /^Cancelled/)
  })
  it('migrates legacy reminders on brain connect', async () => {
    const { robot } = state
    const sent = collect(robot)
    robot.brain.set('reminders', [
      { id: 'old-1', targetId: 'bob-id', targetName: 'bob', room: 'test-room', message: 'legacy', dueAt: Date.now() + 30 }
    ])
    robot.brain.emit('connected')
    assert.equal(robot.brain.get('reminders'), null)
    await tick(80)
    assert.equal(sent[0], '<@bob-id> reminder: legacy')
  })
})
