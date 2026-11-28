import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_PER_PERSON, parseRequest } from '../scripts/Remind.ts'
import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { clock, runDueJobs, tick } from './helpers/fakes.ts'

// mon 2026-11-16 10:00 utc
const NOW = Date.UTC(2026, 10, 16, 10, 0)

describe('Remind request parsing', () => {
  it('splits time-first and time-last phrasings', () => {
    for (const [text, message] of [
      ['in 5 minutes to stretch', 'stretch'],
      ['to stretch in 5 minutes', 'stretch'],
      ['at 3pm to call mom', 'call mom'],
      ['to call mom at 3pm', 'call mom'],
      ['to talk to bob on friday at 10', 'talk to bob'],
      ['tonight that I owe vikraman £12.08', 'I owe vikraman £12.08'],
      ['at 11pm I owe vikraman £12.08', 'I owe vikraman £12.08'],
      ['at 11pm today to pay vikraman £12.08', 'pay vikraman £12.08'],
      ['about the meeting in half an hour', 'about the meeting'],
      ['tomorrow call bob at 3', 'call bob'],
      ['in 5: stretch', 'stretch'],
      ['in 10 minutes - stretch', 'stretch'],
      ['in 10 minutes — to stretch', 'stretch'],
      ['of the dentist tomorrow', 'the dentist'],
      ['in 5 for the call', 'for the call'],
      ['in 5 re the call', 're the call']
    ] as const) assert.strictEqual(parseRequest(text, 'UTC', NOW)?.message, message, text)
  })
  it('keeps " to " inside the message', () => {
    const parsed = parseRequest('tomorrow at 9am to talk to bob about moving to rust', 'UTC', NOW)
    assert.strictEqual(parsed?.message, 'talk to bob about moving to rust')
    assert.strictEqual(parsed?.when.at, Date.UTC(2026, 10, 17, 9, 0))
  })
  it('parses recurring requests', () => {
    const parsed = parseRequest('every weekday at 9am to post standup', 'UTC', NOW)
    assert.strictEqual(parsed?.message, 'post standup')
    assert.strictEqual(parsed?.when.repeat?.kind, 'weekly')
  })
  it('rejects requests without a time', () => {
    assert.strictEqual(parseRequest('to stretch', 'UTC', NOW), undefined)
    assert.strictEqual(parseRequest('sometime to stretch', 'UTC', NOW), undefined)
  })
})

describe('Remind', () => {
  const state = setupRobot('Remind.ts', { envVars: ['OWNER_USER_ID', 'DEFAULT_TIMEZONE'] })

  it('acknowledges one-off and recurring reminders', async () => {
    clock(NOW)
    const { sent, ask } = chat(state)
    await ask('remind me in 5 minutes to stretch')
    await ask('remind me every weekday at 9am to post standup')
    assert.deepStrictEqual(sent, ["Ok, I'll remind you in 5 minutes: stretch", "Ok, I'll remind you every weekday at 9am: post standup"])
  })
  it('takes polite phrasings and reminders without a message', async () => {
    clock(NOW)
    const { robot, sent, ask } = chat(state)
    await ask('can you please remind me tonight that I owe vikraman £12.08')
    await ask('remind me in 10 minutes')
    await ask('remind me to stretch every other day at 8am')
    assert.deepStrictEqual(sent, [
      "Ok, I'll remind you today at 8pm: I owe vikraman £12.08",
      "Ok, I'll remind you in 10 minutes.",
      "Ok, I'll remind you every 2 days, starting tomorrow at 8am: stretch"
    ])
    await runDueJobs(robot, 'remind')
    assert.ok(sent.includes('<@test-user> here is the reminder you asked for.'))
  })
  it('names the timezone only when it is not the default', async () => {
    clock(NOW)
    state.robot.brain.set('tz:user:test-user', 'Asia/Tokyo')
    const { sent, ask } = chat(state)
    await ask('remind me to call mom at 3pm')
    assert.strictEqual(sent[0], "Ok, I'll remind you tomorrow at 3pm (Asia/Tokyo): call mom")
  })
  it('uses DEFAULT_TIMEZONE when the requester has none', async () => {
    process.env.DEFAULT_TIMEZONE = 'America/New_York'
    clock(NOW)
    const { robot, sent, ask } = chat(state)
    await ask('remind me at 3pm to leave')
    assert.strictEqual(sent[0], "Ok, I'll remind you today at 3pm: leave")
    assert.strictEqual(robot.brain.get<{ tz: string }[]>('schedule:remind')![0]!.tz, 'America/New_York')
  })
  it('explains the formats when it cannot parse the time', async () => {
    const { sent, ask } = chat(state)
    await ask('remind me in 5 eons to stretch')
    assert.match(sent[0]!, /couldn't find a time/)
    assert.match(sent[0]!, /every weekday at 9am/)
  })
  it('fires when due and forgets one-off reminders', async () => {
    const { robot, sent, ask } = chat(state)
    await ask('remind me in 5 minutes to stretch')
    await runDueJobs(robot, 'remind')
    assert.strictEqual(sent[1], '<@test-user> reminder: stretch')
    assert.deepStrictEqual(robot.brain.get('schedule:remind'), [])
  })
  it('notifies the target, by name or mention', async () => {
    const { robot, sent, ask } = chat(state)
    brainUser(robot, 'bob-id', 'bob')
    brainUser(robot, '12345', 'carol')
    await ask('remind bob to stretch in 1 minute')
    assert.strictEqual(sent[0], "Ok, I'll remind <@bob-id> in 1 minute: stretch")
    await runDueJobs(robot, 'remind')
    assert.strictEqual(sent[1], '<@bob-id> reminder: stretch')
    await ask('remind <@12345> in 5 minutes to review')
    assert.strictEqual(sent[2], "Ok, I'll remind <@12345> in 5 minutes: review")
  })
  it('never pings unknown names, everyone or roles', async () => {
    const { sent, ask } = chat(state)
    await ask('remind nobody-known in 5 minutes to stretch')
    await ask('remind everyone in 5 minutes to stretch')
    await ask('remind <@&42> in 5 minutes to stretch')
    assert.strictEqual(sent[0], "Ok, I'll remind @​nobody-known in 5 minutes: stretch")
    assert.strictEqual(sent[1], "Ok, I'll remind @​everyone in 5 minutes: stretch")
    assert.doesNotMatch(sent[2]!, /<@&42>/)
  })
  it('lists reminders in this room, numbered by due time', async () => {
    clock(NOW)
    const { robot, sent, ask } = chat(state)
    brainUser(robot, 'bob-id', 'bob')
    await ask('remind bob in 1 hour to review PR')
    await ask('remind me every weekday at 9am to post standup')
    await ask('remind me in 5 minutes to stretch')
    await ask('remind me in 5 minutes to elsewhere', { room: 'other-room' })
    await ask('list reminders')
    assert.strictEqual(sent[4], [
      '1. today at 10:05am for <@test-user>: stretch',
      '2. today at 11am for <@bob-id>: review PR',
      '3. tomorrow at 9am, every weekday at 9am for <@test-user>: post standup'
    ].join('\n'))
    await ask('my reminders', { room: 'other-room' })
    assert.strictEqual(sent[5], '1. today at 10:05am for <@test-user>: elsewhere')
  })
  it('shows only your reminders, keeping room numbers', async () => {
    clock(NOW)
    const { robot, sent, ask } = chat(state)
    brainUser(robot, 'bob-id', 'bob')
    await ask('remind bob in 1 minute to review PR')
    await ask('remind me in 5 minutes to stretch')
    await ask('my reminders')
    assert.strictEqual(sent[2], '2. today at 10:05am for <@test-user>: stretch')
  })
  it('says when there is nothing pending', async () => {
    const { sent, ask } = chat(state)
    await ask('list reminders')
    await ask('my reminders')
    assert.deepStrictEqual(sent, ['No pending reminders in this room.', "You don't have any pending reminders."])
  })
  it('cancels a reminder by number', async () => {
    const { robot, sent, ask } = chat(state)
    await ask('remind me in 5 minutes to stretch')
    await ask('cancel reminder 1')
    assert.strictEqual(sent[1], 'Cancelled reminder for <@test-user>: stretch')
    assert.deepStrictEqual(robot.brain.get('schedule:remind'), [])
    await ask('forget reminder 1')
    assert.match(sent[2]!, /no reminder 1 here/)
  })
  it('only lets the setter, target or owner cancel', async () => {
    process.env.OWNER_USER_ID = 'owner-id'
    const { robot, sent, ask } = chat(state)
    brainUser(robot, 'bob-id', 'bob')
    const eve = brainUser(robot, 'eve-id', 'eve')
    const owner = brainUser(robot, 'owner-id', 'owner')
    await ask('remind bob in 5 minutes to stretch')
    await ask('cancel reminder 1', { user: eve })
    assert.match(sent[1]!, /Only the person/)
    await ask('cancel reminder 1', { user: owner })
    assert.match(sent[2]!, /^Cancelled/)
  })
  it('migrates legacy reminders on brain connect', async () => {
    const { robot, sent } = chat(state)
    robot.brain.set('reminders', [
      { id: 'old-1', targetId: 'bob-id', targetName: 'bob', room: 'test-room', message: 'legacy', dueAt: Date.now() + 30 }
    ])
    robot.brain.emit('connected')
    assert.strictEqual(robot.brain.get('reminders'), null)
    await tick(80)
    assert.strictEqual(sent[0], '<@bob-id> reminder: legacy')
  })
  it('limits reminders per person and hourly repeats for others', async () => {
    delete process.env.OWNER_USER_ID
    const { robot, sent, ask } = chat(state)
    brainUser(robot, 'bob-id', 'bob')
    await ask('remind bob every 10 minutes to drink water')
    assert.strictEqual(sent[0], 'Repeating reminders for someone else can be at most hourly.')
    await ask('remind me every 10 minutes to drink water')
    assert.match(sent[1]!, /^Ok, I'll remind you every 10 minutes/)
    robot.brain.set('schedule:remind', Array.from({ length: MAX_PER_PERSON }, (_, i) => ({ id: `r${i}`, at: Date.now() + 3_600_000, tz: 'UTC', data: { targetId: 'test-user', targetName: 'x', room: 'other', message: 'm', byId: 'test-user' } })))
    await ask('remind me in 5 minutes to stretch')
    assert.match(sent[2]!, new RegExp(`^You already have ${MAX_PER_PERSON} reminders set`))
  })
})
