import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { freezeStreak, recordStreak } from '../scripts/lib/streak.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const DAY = 86_400_000

describe('Streaks', () => {
  const state = setupRobot('Streaks.ts')

  it('says how to start when there are none', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant streaks', 'room')
    assert.match(sent[0]!, /^No streaks yet\./)
  })
  it('lists current and best streaks with the right units', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const start = Date.now()
    for (let d = 0; d < 3; d++) recordStreak(robot, '', 'focus', 'u1', start - (2 - d) * DAY)
    recordStreak(robot, '', 'standup', 'u1', start)
    // broken a while ago
    robot.brain.set('streak:win:u1', { current: 4, best: 6, lastDay: '2020-01-01' })
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant my streaks', 'room')
    assert.equal(sent[0], [
      '🔥 Your streaks:',
      '📋 standup: 1 week (best 1 week)',
      '🎯 focus: 3 days (best 3 days)',
      '🏆 wins: none right now (best 6 days)',
      '(Link GitHub with `my github is <username>` to count commits too.)'
    ].join('\n'))
  })
  it('shows someone else\'s streaks and the top streaks', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    brainUser(robot, 'u2', 'bob')
    robot.brain.set('github:login:u2', 'bob')
    const start = Date.now()
    for (let d = 0; d < 5; d++) recordStreak(robot, '', 'commit', 'u2', start - (4 - d) * DAY)
    for (let d = 0; d < 2; d++) recordStreak(robot, '', 'commit', 'u1', start - (1 - d) * DAY)
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant streaks for bob', 'room')
    assert.equal(sent[0], "🔥 <@u2>'s streaks:\n🐙 commit: 5 days (best 5 days)")
    await robot.adapter.say(alice, '@Dumbotheelephant top streaks', 'room')
    assert.equal(sent[1], '🔥 Longest running streaks:\n🐙 commit: <@u2> (5 days), <@u1> (2 days)')
  })
  it('pauses a streak over a skipped period', () => {
    const { robot } = state
    const start = Date.now()
    recordStreak(robot, '', 'standup', 'u1', start)
    assert.equal(freezeStreak(robot, '', 'standup', 'u1', start + 7 * DAY), true)
    assert.equal(recordStreak(robot, '', 'standup', 'u1', start + 14 * DAY), undefined)
    assert.equal(robot.brain.get<{ current: number }>('streak:standup:u1')!.current, 2)
    mock.reset()
  })
  it('keeps daily streaks going across the spring clock change', () => {
    const { robot } = state
    robot.brain.set('tz:user:u1', 'Europe/London')
    // london clocks go forward on 29 march 2026
    recordStreak(robot, '', 'win', 'u1', Date.UTC(2026, 2, 28, 12))
    recordStreak(robot, '', 'win', 'u1', Date.UTC(2026, 2, 29, 12))
    // 00:30 bst on the 30th
    recordStreak(robot, '', 'win', 'u1', Date.UTC(2026, 2, 29, 23, 30))
    assert.equal(robot.brain.get<{ current: number }>('streak:win:u1')!.current, 3)
  })
  it('ignores activity that arrives late for an earlier day', () => {
    const { robot } = state
    for (const day of [14, 15]) recordStreak(robot, '', 'commit', 'u1', Date.UTC(2026, 10, day, 12))
    recordStreak(robot, '', 'commit', 'u1', Date.UTC(2026, 10, 16, 0, 5))
    recordStreak(robot, '', 'commit', 'u1', Date.UTC(2026, 10, 15, 23, 55))
    assert.deepEqual(robot.brain.get('streak:commit:u1'), { current: 3, best: 3, lastDay: '2026-11-16' })
  })
})
