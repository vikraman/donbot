import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { configureLines } from '../scripts/lib/lines.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { dayKey, weekKey } from '../scripts/lib/time.ts'
import { defaultTz } from '../scripts/lib/timezone.ts'
import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { runDueJobs } from './helpers/fakes.ts'

const DAY = 86_400_000

describe('Recap', () => {
  // alice (u1) owns the bot
  const state = setupRobot('Recap.ts', { owner: 'u1' })
  const alice = () => chat(state, { id: 'u1', name: 'alice', room: 'room' })

  it('says it was a quiet week with nothing logged', async () => {
    const { sent, ask } = alice()
    await ask('recap')
    assert.match(sent[0]!, /quiet week/)
  })
  it('keeps a quiet-week recap plain in professional rooms', async () => {
    setRandomSource(() => 0.99)
    configureLines({ casual: () => false })
    const { sent, ask } = alice()
    await ask('recap')
    assert.match(sent[0]!, /^📰 Weekly recap: a quiet week here\./)
  })
  it('summarizes the week from every log, for this room only', async () => {
    setRandomSource(() => 0)
    const { robot, sent, ask } = alice()
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
    await ask('recap')
    assert.strictEqual(sent[0], [
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
    const { robot, sent, ask } = alice()
    await ask('recap status')
    assert.match(sent[0]!, /^No recap scheduled/)
    await ask('recap on')
    assert.match(sent[1]!, /^Weekly recap on, every Friday at 4pm\. First one /)
    await ask('recap on every monday at 9am')
    assert.match(sent[2]!, /every Monday at 9am/)
    assert.strictEqual(robot.brain.get<unknown[]>('schedule:recap')!.length, 1)
    await ask('recap off')
    assert.strictEqual(sent[3], 'Weekly recap off for this channel.')
  })
  it('lets only channel managers turn the recap on or off', async () => {
    const { robot, sent, ask } = alice()
    const bob = brainUser(robot, 'u2', 'bob')
    await ask('recap on', { user: bob })
    await ask('recap on')
    await ask('recap off', { user: bob })
    assert.strictEqual(sent[0], 'Only someone who can manage this channel can do that.')
    assert.strictEqual(sent[2], 'Only someone who can manage this channel can do that.')
    assert.strictEqual(robot.brain.get<unknown[]>('schedule:recap')!.length, 1)
  })
  it('posts on schedule', async () => {
    const { robot, sent, ask } = alice()
    await ask('recap on')
    await runDueJobs(robot, 'recap')
    assert.match(sent[1]!, /quiet week/)
  })
  it('adds earned highlights for big weeks', async () => {
    setRandomSource(() => 0)
    const { robot, sent, ask } = alice()
    const now = Date.now()
    robot.brain.set('log:win', Array.from({ length: 10 }, (_, i) => ({ ts: now - DAY, room: 'room', userId: 'u1', text: `w${i}` })))
    robot.brain.set('log:focus', [{ ts: now - DAY, room: 'room', userId: 'u1', minutes: 11 * 60 }])
    robot.brain.set('log:standup', [{ ts: now - DAY, room: 'room', userId: 'u1' }, { ts: now - DAY, room: 'room', userId: 'u2' }])
    robot.brain.set('standup:round:room', { startedAt: now - DAY, expected: ['u1', 'u2'], checkIns: [{ userId: 'u1' }, { userId: 'u2' }] })
    await ask('recap')
    assert.match(sent[0]!, /🌪️ 10 wins in one week\./)
    assert.match(sent[0]!, /🧠 Over 11 hours of focus this week\./)
    assert.match(sent[0]!, /💯 Perfect standup attendance/)
  })
  it('varies the quiet-week message without repeating', async () => {
    const { sent, ask } = alice()
    for (let i = 0; i < 20; i++) await ask('recap')
    assert.ok(sent.every(s => /quiet week/.test(s)))
    assert.ok(new Set(sent).size > 4)
  })
  it('lists running streaks of people active in the room, weeks first', async () => {
    const { robot, sent, ask } = alice()
    const now = Date.now()
    robot.brain.set('log:win', [
      { ts: now - DAY, room: 'room', userId: 'u1', text: 'a' },
      { ts: now - DAY, room: 'room', userId: 'u2', text: 'b' },
      { ts: now - DAY, room: 'other', userId: 'u3', text: 'c' }
    ])
    const today = dayKey(now, defaultTz())
    const monday = weekKey(now, defaultTz())
    robot.brain.set('streak:focus:u1', { current: 9, best: 9, lastDay: today })
    robot.brain.set('streak:standup:u2', { current: 3, best: 3, lastDay: monday })
    robot.brain.set('streak:win:u2', { current: 2, best: 2, lastDay: today })
    // active elsewhere only
    robot.brain.set('streak:focus:u3', { current: 30, best: 30, lastDay: today })
    await ask('recap')
    assert.match(sent[0]!, /🔥 Streaks going: <@u2> 3-week standup, <@u1> 9-day focus\./)
    assert.doesNotMatch(sent[0]!, /u3/)
  })
})
