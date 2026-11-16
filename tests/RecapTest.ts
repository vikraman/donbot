import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setRandomSource } from '../scripts/lib/random.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const DAY = 86_400_000

describe('Recap', () => {
  const state = setupRobot('Recap.ts')

  it('says it was a quiet week with nothing logged', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant recap', 'room')
    assert.match(sent[0]!, /quiet week/)
  })
  it('summarizes the week from every log, for this room only', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const now = Date.now()
    robot.brain.set('log:kudos', [
      { ts: now - DAY, room: 'room', userId: 'u1', target: '<@u2>', targetId: 'u2', reason: 'fixing the deploy', delta: 1 },
      { ts: now - DAY, room: 'room', userId: 'u3', target: '<@u2>', targetId: 'u2', delta: 1 },
      { ts: now - DAY, room: 'room', userId: 'u2', target: 'coffee', delta: 1 },
      { ts: now - DAY, room: 'room', userId: 'u2', target: 'mondays', delta: -1 },
      { ts: now - 10 * DAY, room: 'room', userId: 'u2', target: '<@u1>', targetId: 'u1', delta: 1 },
      { ts: now - DAY, room: 'other', userId: 'u2', target: '<@u1>', targetId: 'u1', delta: 1 }
    ])
    robot.brain.set('log:win', [{ ts: now - DAY, room: 'room', userId: 'u1', text: 'shipped polls' }])
    robot.brain.set('log:focus', [
      { ts: now - DAY, room: 'room', userId: 'u1', minutes: 50 },
      { ts: now - DAY, room: 'room', userId: 'u2', minutes: 25 }
    ])
    robot.brain.set('log:standup', [{ ts: now - DAY, room: 'room', userId: 'u1' }, { ts: now - 2 * DAY, room: 'room', userId: 'u1' }])
    robot.brain.set('log:github', [
      { ts: now - DAY, room: 'room', repo: 'a/b', kind: 'merged', actor: 'octo' },
      { ts: now - DAY, room: 'room', repo: 'a/b', kind: 'release', actor: 'octo' }
    ])
    robot.brain.set('history:room', [
      { ts: now - DAY, kind: 'user-message', authorId: 'u2', id: '1' },
      { ts: now - DAY, kind: 'user-message', authorId: 'u2', id: '2' },
      { ts: now - DAY, kind: 'user-message', authorId: 'u1', id: '3' }
    ])
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant recap', 'room')
    assert.equal(sent[0], [
      '📰 **Weekly recap**',
      '',
      '💛 3 kudos given, most to <@u2> (2).',
      '  “fixing the deploy” → <@u2>',
      '',
      '🏆 1 win logged:',
      '  • <@u1>: shipped polls',
      '',
      '🎯 1h 15m of focus in 2 sessions, longest by <@u1> (50m).',
      '',
      '📋 2 standup check-ins from 1 person.',
      '',
      '🐙 1 PR merged, 1 release. Thanks octo!',
      '',
      '💬 3 messages, most from <@u2>.',
      '',
      'Great week, everyone. Rest up. 🌴'
    ].join('\n'))
  })
  it('schedules, reports and stops the weekly recap', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant recap status', 'room')
    assert.match(sent[0]!, /^No recap scheduled/)
    await robot.adapter.say(user, '@Dumbotheelephant recap on', 'room')
    assert.match(sent[1]!, /^Weekly recap on, every Friday at 4pm\. First one /)
    await robot.adapter.say(user, '@Dumbotheelephant recap on every monday at 9am', 'room')
    assert.match(sent[2]!, /every Monday at 9am/)
    assert.equal(robot.brain.get<unknown[]>('schedule:recap')!.length, 1)
    await robot.adapter.say(user, '@Dumbotheelephant recap off', 'room')
    assert.equal(sent[3], 'Weekly recap off for this channel.')
  })
  it('posts on schedule', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant recap on', 'room')
    const jobs = robot.brain.get<{ at: number }[]>('schedule:recap')!
    robot.brain.set('schedule:recap', jobs.map(j => ({ ...j, at: Date.now() })))
    robot.brain.emit('connected')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.match(sent[1]!, /quiet week/)
  })
  it('adds earned highlights for big weeks', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const now = Date.now()
    robot.brain.set('log:win', Array.from({ length: 10 }, (_, i) => ({ ts: now - DAY, room: 'room', userId: 'u1', text: `w${i}` })))
    robot.brain.set('log:focus', [{ ts: now - DAY, room: 'room', userId: 'u1', minutes: 11 * 60 }])
    robot.brain.set('log:standup', [{ ts: now - DAY, room: 'room', userId: 'u1' }, { ts: now - DAY, room: 'room', userId: 'u2' }])
    robot.brain.set('standup:round:room', { startedAt: now - DAY, expected: ['u1', 'u2'], checkIns: [{ userId: 'u1' }, { userId: 'u2' }] })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant recap', 'room')
    assert.match(sent[0]!, /🌪️ 10 wins in one week\./)
    assert.match(sent[0]!, /🧠 Over 11 hours of focus this week\./)
    assert.match(sent[0]!, /💯 Perfect standup attendance/)
  })
  it('varies the quiet-week message without repeating', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    for (let i = 0; i < 20; i++) await robot.adapter.say(user, '@Dumbotheelephant recap', 'room')
    assert.ok(sent.every(s => /quiet week/.test(s)))
    assert.ok(new Set(sent).size > 4)
  })
})
