import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { formatTocks, parseCycle } from '../scripts/Focus.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// make the current phase due now
const finishPhase = async (robot: Parameters<typeof collect>[0]) => {
  const jobs = robot.brain.get<{ at: number }[]>('schedule:focus')!
  robot.brain.set('schedule:focus', jobs.map(j => ({ ...j, at: Date.now() })))
  robot.brain.emit('connected')
  await tick(30)
}

describe('Focus', () => {
  const state = setupRobot('Focus.ts')

  it('starts a default 25 minute session', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant focus', 'room')
    assert.match(sent[0]!, /^🎯 Focusing for 25m\. \S/)
  })
  it('accepts a duration and task', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant focus 1 hour on the parser', 'room')
    assert.match(sent[0]!, /^🎯 Focusing for 1h on the parser\. \S/)
  })
  it('refuses a second session and rejects silly durations', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant focus 10 hours', 'room')
    assert.match(sent[0]!, /between 1 minute and 4 hours/)
    await robot.adapter.say(user, '@Dumbotheelephant focus 5 seconds', 'room')
    assert.match(sent[1]!, /don't understand/)
    await robot.adapter.say(user, '@Dumbotheelephant focus 20m', 'room')
    await robot.adapter.say(user, '@Dumbotheelephant focus 20m', 'room')
    assert.match(sent[3]!, /already focusing, 20m to go/)
  })
  it('pings when time is up, logs it and starts a streak', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant focus 1m on docs', 'room')
    // jump the job forward instead of waiting a minute
    const jobs = robot.brain.get<{ at: number }[]>('schedule:focus')!
    robot.brain.set('schedule:focus', jobs.map(j => ({ ...j, at: Date.now() })))
    robot.brain.emit('connected')
    await tick(30)
    assert.match(sent[1]!, /^⏰ <@u1> 1m of focus on docs done\./)
    const log = robot.brain.get<{ minutes: number, userId: string }[]>('log:focus')!
    assert.deepEqual(log.map(e => [e.userId, e.minutes]), [['u1', 1]])
    assert.equal(robot.brain.get<{ current: number }>('streak:focus:u1')!.current, 1)
  })
  it('counts an early stop after 5 minutes but not before', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    const start = Date.now()
    await robot.adapter.say(user, '@Dumbotheelephant focus 30m', 'room')
    await robot.adapter.say(user, '@Dumbotheelephant focus stop', 'room')
    assert.equal(sent[1], 'Focus session cancelled.')
    const now = mock.method(Date, 'now', () => start)
    await robot.adapter.say(user, '@Dumbotheelephant focus 30m', 'room')
    now.mock.mockImplementation(() => start + 12 * 60_000)
    await robot.adapter.say(user, '@Dumbotheelephant done focusing', 'room')
    assert.equal(sent[3], '<@u1> stopped after 12m. Still counts.')
    await robot.adapter.say(user, '@Dumbotheelephant focus stop', 'room')
    assert.equal(sent[4], "You're not in a focus session.")
  })
  it("lists who's focusing", async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    const bob = brainUser(robot, 'u2', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, "@Dumbotheelephant who's focusing", 'room')
    assert.equal(sent[0], 'Nobody is focusing right now.')
    await robot.adapter.say(alice, '@Dumbotheelephant focus 25m on tests', 'room')
    await robot.adapter.say(bob, '@Dumbotheelephant focus 50m', 'room')
    await robot.adapter.say(bob, '@Dumbotheelephant who is focusing?', 'room')
    assert.equal(sent[3], '🤫 Focusing now:\n<@u1> on tests, 25m left\n<@u2>, 50m left')
  })
  it('shows weekly stats', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant focus stats', 'room')
    assert.match(sent[0]!, /^No focus sessions/)
    robot.brain.set('log:focus', [
      { ts: Date.now() - 1000, userId: 'u1', room: 'room', minutes: 25 },
      { ts: Date.now() - 2000, userId: 'u1', room: 'room', minutes: 50 },
      { ts: Date.now() - 3000, userId: 'u2', room: 'room', minutes: 90 }
    ])
    await robot.adapter.say(user, '@Dumbotheelephant focus stats', 'room')
    assert.equal(sent[1], '1h 15m of focus over 2 sessions in the last 7 days.')
  })

  it('parses pomodoro lengths', () => {
    assert.deepEqual(parseCycle(undefined), { work: 25, short: 5, long: 15 })
    assert.deepEqual(parseCycle('50/10'), { work: 50, short: 10, long: 30 })
    assert.deepEqual(parseCycle('25/5/20'), { work: 25, short: 5, long: 20 })
    assert.equal(parseCycle('25/0'), undefined)
    assert.equal(parseCycle('25/90'), undefined)
  })
  it('runs pomodoro rounds with breaks and a long break every 4th', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant pomodoro 5 on thesis', 'room')
    assert.equal(sent[0], '🍅 Pomodoros on thesis: 25m work, 5m breaks, 15m every 4th, 5 rounds. Round 1, go!')
    await finishPhase(robot)
    assert.equal(sent[1], '🍅 <@u1> round 1 of 5 done. ☕ 5m break: Stand up and stretch.')
    await robot.adapter.say(user, "@Dumbotheelephant who's focusing", 'room')
    assert.equal(sent[2], '🤫 Focusing now:\n<@u1> on a break, 5m left ☕')
    await finishPhase(robot)
    assert.equal(sent[3], "⏰ <@u1> break's over. Round 2 of 5, 25m on thesis. Go!")
    await robot.adapter.say(user, "@Dumbotheelephant who's focusing", 'room')
    assert.equal(sent[4], '🤫 Focusing now:\n<@u1> on thesis (round 2 of 5), 25m left')
    for (let i = 0; i < 5; i++) await finishPhase(robot)
    assert.equal(sent[9], "🍅 <@u1> round 4 of 5 done. ☕ 15m long break: Step away from the screen.\n🍅🍅🍅🍅 Four in a row, <@u1>. That's a full set.")
    await finishPhase(robot)
    await finishPhase(robot)
    assert.equal(sent[11], '🍅 <@u1> done: 5 rounds, 2h 5m of focus on thesis. Nice work. Stretch, drink some water.')
    assert.equal(robot.brain.get<unknown[]>('log:focus')!.length, 5)
    assert.deepEqual(robot.brain.get('schedule:focus'), [])
  })
  it('skips breaks and stops open-ended pomodoros', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant skip break', 'room')
    assert.equal(sent[0], "You're not on a break.")
    await robot.adapter.say(user, '@Dumbotheelephant pomodoro 50/10', 'room')
    assert.match(sent[1]!, /50m work, 10m breaks, 30m every 4th, until you stop/)
    await robot.adapter.say(user, '@Dumbotheelephant focus 20m', 'room')
    assert.match(sent[2]!, /already focusing/)
    await finishPhase(robot)
    await robot.adapter.say(user, '@Dumbotheelephant skip the break', 'room')
    assert.equal(sent[4], "⏰ <@u1> break's over. Round 2, 50m. Go!")
    await robot.adapter.say(user, '@Dumbotheelephant pomodoro stop', 'room')
    assert.equal(sent[5], '🍅 <@u1> done: 1 round, 50m of focus. Nice work. Stretch, drink some water.')
  })
  it('rejects bad pomodoro settings', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant pomodoro 40', 'room')
    assert.match(sent[0]!, /^Try `pomodoro`/)
  })

  it('formats tock counts', () => {
    assert.equal(formatTocks(1), '1 tock')
    assert.equal(formatTocks(37 / 45), '0.82 tocks')
    assert.equal(formatTocks(2.5), '2.5 tocks')
  })
  it('needs a task up front for tocks', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant tock', 'room')
    assert.equal(sent[0], 'Tocks start with a task, decided up front: `tock on <task>`.')
  })
  it('runs tocks with 15m breaks, parked distractions and a new task per tock', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant tock 2 on chapter 3', 'room')
    assert.equal(sent[0], '🕰️ Tock on chapter 3: 45m, then a 15m break, 2 tocks. `distraction <note>` parks stray thoughts. Go!')
    await robot.adapter.say(user, '@Dumbotheelephant distraction email bob', 'room')
    assert.equal(sent[1], '📝 Parked. Back to it.')
    await finishPhase(robot)
    assert.equal(sent[2], '🕰️ <@u1> tock 1 of 2 done. ☕ 15m break: Stand up and stretch.\n📝 Parked: email bob\nNext tock stays on chapter 3; `tock on <task>` changes it.')
    await robot.adapter.say(user, '@Dumbotheelephant distraction nope', 'room')
    assert.match(sent[3]!, /^Only while focusing/)
    await robot.adapter.say(user, '@Dumbotheelephant tock on references', 'room')
    assert.equal(sent[4], 'Next tock: references.')
    await finishPhase(robot)
    assert.equal(sent[5], "⏰ <@u1> break's over. Tock 2 of 2, 45m on references. Off you go.")
    await robot.adapter.say(user, "@Dumbotheelephant who's focusing", 'room')
    assert.equal(sent[6], '🤫 Focusing now:\n<@u1> on references (tock 2 of 2), 45m left')
    await finishPhase(robot)
    assert.equal(sent[7], '🕰️ <@u1> done: 2 tocks, 1h 30m of focus on references. Nice work. Stretch, drink some water.')
    const log = robot.brain.get<{ task: string, tocks: number }[]>('log:focus')!
    assert.deepEqual(log.map(e => [e.task, e.tocks]), [['chapter 3', 1], ['references', 1]])
  })
  it('credits a partial tock as a fraction', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    const start = Date.now()
    const now = mock.method(Date, 'now', () => start)
    await robot.adapter.say(user, '@Dumbotheelephant tock on essay', 'room')
    now.mock.mockImplementation(() => start + 37 * 60_000)
    await robot.adapter.say(user, '@Dumbotheelephant stop tock', 'room')
    assert.equal(sent[1], '🕰️ <@u1> done: 0.82 tocks, 37m of focus on essay. Nice work. Stretch, drink some water.')
    await robot.adapter.say(user, '@Dumbotheelephant tocks', 'room')
    assert.equal(sent[2], '0.82 tocks today, 0.82 tocks in the last 7 days.')
    await robot.adapter.say(user, '@Dumbotheelephant focus stats', 'room')
    assert.equal(sent[3], '37m of focus over 1 session, 0.82 tocks in the last 7 days. You\'re on a 1-day streak (best 1).')
  })
  it('celebrates a full tock day and a 10 hour focus week once each', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    robot.brain.set('log:focus', [
      { ts: Date.now() - 1000, userId: 'u1', room: 'room', minutes: 45, tocks: 1 },
      { ts: Date.now() - 2000, userId: 'u1', room: 'room', minutes: 45, tocks: 1 },
      { ts: Date.now() - 3000, userId: 'u1', room: 'room', minutes: 45, tocks: 1 },
      { ts: Date.now() - 4000, userId: 'u1', room: 'room', minutes: 450 }
    ])
    await robot.adapter.say(user, '@Dumbotheelephant tock 2 on essay', 'room')
    await finishPhase(robot)
    assert.match(sent[1]!, /\n🕰️ 4 tocks today, <@u1>\. That's a full tock day\.\n🏔️ <@u1> just passed 10 hours of focus this week\./)
    await finishPhase(robot)
    await finishPhase(robot)
    assert.doesNotMatch(sent[3]!, /🕰️ 5|🏔️/)
  })
})
