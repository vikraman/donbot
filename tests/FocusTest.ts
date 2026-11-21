import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { formatTocks, parseCycle } from '../scripts/Focus.ts'
import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { clock, runDueJobs } from './helpers/fakes.ts'

describe('Focus', () => {
  const state = setupRobot('Focus.ts')
  const alice = () => chat(state, { id: 'u1', name: 'alice', room: 'room' })
  const finishPhase = () => runDueJobs(state.robot, 'focus')

  it('starts sessions with an optional duration and task', async () => {
    const { sent, ask } = alice()
    await ask('focus')
    assert.match(sent[0]!, /^🎯 Focusing for 25m\. \S/)
    await ask('focus stop')
    await ask('focus 1 hour on the parser')
    assert.match(sent[2]!, /^🎯 Focusing for 1h on the parser\. \S/)
  })

  it('refuses a second session and rejects silly durations', async () => {
    const { sent, ask } = alice()
    await ask('focus 10 hours')
    assert.match(sent[0]!, /between 1 minute and 4 hours/)
    await ask('focus 5 seconds')
    assert.match(sent[1]!, /don't understand/)
    await ask('focus 20m')
    await ask('focus 20m')
    assert.match(sent[3]!, /already focusing, 20m to go/)
  })

  it('pings when time is up, logs it and starts a streak', async () => {
    const { robot, sent, ask } = alice()
    await ask('focus 1m on docs')
    await finishPhase()
    assert.match(sent[1]!, /^⏰ <@u1> 1m of focus on docs done\./)
    const log = robot.brain.get<{ minutes: number, userId: string }[]>('log:focus')!
    assert.deepStrictEqual(log.map(e => [e.userId, e.minutes]), [['u1', 1]])
    assert.strictEqual(robot.brain.get<{ current: number }>('streak:focus:u1')!.current, 1)
  })

  it('counts an early stop after 5 minutes but not before', async () => {
    const { sent, ask } = alice()
    await ask('focus 30m')
    await ask('focus stop')
    assert.strictEqual(sent[1], 'Focus session cancelled.')
    const t = clock()
    await ask('focus 30m')
    t.advance(12 * 60_000)
    await ask('done focusing')
    assert.strictEqual(sent[3], '<@u1> stopped after 12m. Still counts.')
    await ask('focus stop')
    assert.strictEqual(sent[4], "You're not in a focus session.")
  })

  it("lists who's focusing, with tasks only in their own room", async () => {
    const { robot, sent, ask } = alice()
    const bob = brainUser(robot, 'u2', 'bob')
    await ask("who's focusing")
    assert.strictEqual(sent[0], 'Nobody is focusing right now.')
    await ask('focus 25m on the surprise party', { room: 'dm-alice' })
    await ask('focus 50m', { user: bob })
    await ask('who is focusing?', { user: bob })
    assert.strictEqual(sent[3], '🤫 Focusing now:\n<@u1>, 25m left\n<@u2>, 50m left')
    await ask("who's focusing", { room: 'dm-alice' })
    assert.strictEqual(sent[4], '🤫 Focusing now:\n<@u1> on the surprise party, 25m left\n<@u2>, 50m left')
  })

  it('shows weekly stats', async () => {
    const { robot, sent, ask } = alice()
    await ask('focus stats')
    assert.match(sent[0]!, /^No focus sessions/)
    robot.brain.set('log:focus', [
      { ts: Date.now() - 1000, userId: 'u1', room: 'room', minutes: 25 },
      { ts: Date.now() - 2000, userId: 'u1', room: 'room', minutes: 50 },
      { ts: Date.now() - 3000, userId: 'u2', room: 'room', minutes: 90 }
    ])
    await ask('focus stats')
    assert.strictEqual(sent[1], '1h 15m of focus over 2 sessions in the last 7 days.')
  })

  it('parses pomodoro lengths', () => {
    assert.deepStrictEqual(parseCycle(undefined), { work: 25, short: 5, long: 15 })
    assert.deepStrictEqual(parseCycle('50/10'), { work: 50, short: 10, long: 30 })
    assert.deepStrictEqual(parseCycle('25/5/20'), { work: 25, short: 5, long: 20 })
    assert.strictEqual(parseCycle('25/0'), undefined)
    assert.strictEqual(parseCycle('25/90'), undefined)
  })

  it('runs pomodoro rounds with breaks and a long break every 4th', async () => {
    const { robot, sent, ask } = alice()
    await ask('pomodoro 5 on thesis')
    assert.strictEqual(sent[0], '🍅 Pomodoros on thesis: 25m work, 5m breaks, 15m every 4th, 5 rounds. Round 1, go!')
    await finishPhase()
    assert.match(sent[1]!, /^🍅 <@u1> round 1 of 5 done\. ☕ 5m break: .+$/)
    await ask("who's focusing")
    assert.strictEqual(sent[2], '🤫 Focusing now:\n<@u1> on a break, 5m left ☕')
    await finishPhase()
    assert.match(sent[3]!, /^⏰ <@u1> break's over\. Round 2 of 5, 25m on thesis\. .+$/)
    await ask("who's focusing")
    assert.strictEqual(sent[4], '🤫 Focusing now:\n<@u1> on thesis (round 2 of 5), 25m left')
    for (let i = 0; i < 5; i++) await finishPhase()
    assert.match(sent[9]!, /^🍅 <@u1> round 4 of 5 done\. ☕ 15m long break: .+\n🍅.*<@u1>/)
    await finishPhase()
    await finishPhase()
    assert.match(sent[11]!, /^🍅 <@u1> done: 5 rounds, 2h 5m of focus on thesis\. .+$/)
    assert.strictEqual(robot.brain.get<unknown[]>('log:focus')!.length, 5)
    assert.deepStrictEqual(robot.brain.get('schedule:focus'), [])
  })

  it('skips breaks and stops open-ended pomodoros', async () => {
    const { sent, ask } = alice()
    await ask('skip break')
    assert.strictEqual(sent[0], "You're not on a break.")
    await ask('pomodoro 50/10')
    assert.match(sent[1]!, /50m work, 10m breaks, 30m every 4th, until you stop/)
    await ask('focus 20m')
    assert.match(sent[2]!, /already focusing/)
    await finishPhase()
    await ask('skip the break')
    assert.match(sent[4]!, /^⏰ <@u1> break's over\. Round 2, 50m\. .+$/)
    await ask('pomodoro stop')
    assert.match(sent[5]!, /^🍅 <@u1> done: 1 round, 50m of focus\. .+$/)
  })

  it('rejects bad pomodoro settings', async () => {
    const { sent, ask } = alice()
    await ask('pomodoro 40')
    assert.match(sent[0]!, /^Try `pomodoro`/)
  })

  it('formats tock counts', () => {
    assert.strictEqual(formatTocks(1), '1 tock')
    assert.strictEqual(formatTocks(37 / 45), '0.82 tocks')
    assert.strictEqual(formatTocks(2.5), '2.5 tocks')
  })

  it('runs tocks with 15m breaks, parked distractions and a new task per tock', async () => {
    const { robot, sent, ask } = alice()
    await ask('tock')
    assert.strictEqual(sent[0], 'Tocks start with a task, decided up front: `tock on <task>`.')
    await ask('tock 2 on chapter 3')
    assert.match(sent[1]!, /^🕰️ Tock on chapter 3: 45m, then a 15m break, 2 tocks\. `distraction <note>` parks stray thoughts\. .+$/)
    await ask('distraction email bob')
    assert.match(sent[2]!, /^📝 /)
    await finishPhase()
    assert.match(sent[3]!, /^🕰️ <@u1> tock 1 of 2 done\. ☕ 15m break: .+\n📝 Parked: email bob\nNext tock stays on chapter 3; `tock on <task>` changes it\.$/)
    await ask('distraction nope')
    assert.match(sent[4]!, /^Only while focusing/)
    await ask('tock on references')
    assert.strictEqual(sent[5], 'Next tock: references.')
    await finishPhase()
    assert.match(sent[6]!, /^⏰ <@u1> break's over\. Tock 2 of 2, 45m on references\. .+$/)
    await ask("who's focusing")
    assert.strictEqual(sent[7], '🤫 Focusing now:\n<@u1> on references (tock 2 of 2), 45m left')
    await finishPhase()
    assert.match(sent[8]!, /^🕰️ <@u1> done: 2 tocks, 1h 30m of focus on references\. .+$/)
    const log = robot.brain.get<{ task: string, tocks: number }[]>('log:focus')!
    assert.deepStrictEqual(log.map(e => [e.task, e.tocks]), [['chapter 3', 1], ['references', 1]])
  })

  it('credits a partial tock as a fraction', async () => {
    const { sent, ask } = alice()
    const t = clock()
    await ask('tock on essay')
    t.advance(37 * 60_000)
    await ask('stop tock')
    assert.match(sent[1]!, /^🕰️ <@u1> done: 0\.82 tocks, 37m of focus on essay\. /)
    await ask('tocks')
    assert.strictEqual(sent[2], '0.82 tocks today, 0.82 tocks in the last 7 days.')
    await ask('focus stats')
    assert.strictEqual(sent[3], '37m of focus over 1 session, 0.82 tocks in the last 7 days. You\'re on a 1-day streak (best 1).')
  })

  it('celebrates a full tock day and a 10 hour focus week once each', async () => {
    const { robot, sent, ask } = alice()
    robot.brain.set('log:focus', [
      { ts: Date.now() - 1000, userId: 'u1', room: 'room', minutes: 45, tocks: 1 },
      { ts: Date.now() - 2000, userId: 'u1', room: 'room', minutes: 45, tocks: 1 },
      { ts: Date.now() - 3000, userId: 'u1', room: 'room', minutes: 45, tocks: 1 },
      { ts: Date.now() - 4000, userId: 'u1', room: 'room', minutes: 450 }
    ])
    await ask('tock 2 on essay')
    await finishPhase()
    assert.match(sent[1]!, /\n🕰️ .*(4 tocks.*<@u1>|<@u1>.*4 tocks).*\n🏔️ .*<@u1>/)
    await finishPhase()
    await finishPhase()
    assert.doesNotMatch(sent[3]!, /🕰️ .*5 tocks|🏔️/)
  })
})
