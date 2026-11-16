import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setRandomSource } from '../scripts/lib/random.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const DAY = 86_400_000

describe('Wins', () => {
  const state = setupRobot('Wins.ts')

  it('logs a win and cheers', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant win shipped the parser', 'room')
    assert.equal(sent.length, 1)
    assert.equal(sent[0], '🎉 Nice one, <@u1>!')
    const log = robot.brain.get<{ text: string, userId: string, room: string }[]>('log:win')!
    assert.deepEqual(log.map(w => [w.userId, w.room, w.text]), [['u1', 'room', 'shipped the parser']])
  })
  it('accepts "win:" and announces streak milestones', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    const start = Date.now()
    for (let day = 0; day < 3; day++) {
      mock.method(Date, 'now', () => start + day * DAY)
      await robot.adapter.say(user, `@Dumbotheelephant win: thing ${day}`, 'room')
      mock.restoreAll()
    }
    assert.equal(sent[2], '🏆 Logged. Well done, <@u1>.\n🔥 <@u1> is on a 3-day wins streak!')
  })
  it('lists this week\'s wins in the room, newest first', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    const bob = brainUser(robot, 'u2', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant wins', 'room')
    assert.match(sent[0]!, /^No wins logged here/)
    await robot.adapter.say(alice, '@Dumbotheelephant win fixed ci', 'room')
    await robot.adapter.say(bob, '@Dumbotheelephant win wrote docs', 'room')
    await robot.adapter.say(bob, '@Dumbotheelephant win elsewhere', 'other')
    await robot.adapter.say(alice, '@Dumbotheelephant wins week', 'room')
    assert.equal(sent[4], '• <@u2>: wrote docs (just now)\n• <@u1>: fixed ci (just now)')
  })
  it('lists wins for a person', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant win one', 'room')
    await robot.adapter.say(alice, '@Dumbotheelephant win two', 'other')
    await robot.adapter.say(alice, '@Dumbotheelephant wins for alice', 'room')
    assert.equal(sent[2], '• <@u1>: two (just now)\n• <@u1>: one (just now)')
    await robot.adapter.say(alice, '@Dumbotheelephant wins for nobody', 'room')
    assert.equal(sent[3], "I don't know nobody.")
  })
  it('notices busy days and celebrates milestone wins', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    for (let i = 0; i < 3; i++) await robot.adapter.say(user, `@Dumbotheelephant win thing ${i}`, 'room')
    assert.equal(sent[2], "🏆 Logged. Well done, <@u1>.\nThat's 3 wins today. Save some for the rest of us.")
    robot.brain.set('wins:count:u1', 9)
    await robot.adapter.say(user, '@Dumbotheelephant win the tenth', 'room')
    assert.equal(sent[3], "✨ That's a win, <@u1>.\n🎊 That's win number 10 for <@u1>. Milestone unlocked!")
  })
  it('does not repeat a cheer back to back', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    for (let i = 0; i < 40; i++) await robot.adapter.say(user, `@Dumbotheelephant win w${i}`, 'room')
    const cheers = sent.map(s => s.split('\n')[0])
    cheers.forEach((c, i) => { if (i) assert.notEqual(c, cheers[i - 1]) })
  })
})
