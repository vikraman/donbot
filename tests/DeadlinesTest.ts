import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'
import { discordMessage, runDueJobs, withMessage } from './helpers/fakes.ts'

import { parseDue } from '../scripts/Deadlines.ts'
import { policyFor } from '../scripts/lib/policy.ts'
import { DAY_MS, fromZoned } from '../scripts/lib/time.ts'

const TZ = 'Europe/London'
// wed 19 nov 2026, 10:00
const NOW = fromZoned(2026, 11, 19, 10, 0, TZ)

// user in g1, optionally staff
const sayer = (robot: TestRobot) => async (id: string, text: string, { room = 'room', staff = false } = {}) => {
  const user = withMessage(brainUser(robot, id, id), discordMessage(room, id, { manageChannels: staff }))
  await robot.adapter.say(user, `@${robot.name} ${text}`, room)
}

describe('parseDue', () => {
  it('reads iso and month-name dates, end of day by default', () => {
    assert.strictEqual(parseDue('2026-12-12', TZ, NOW), fromZoned(2026, 12, 12, 23, 59, TZ))
    assert.strictEqual(parseDue('2026-12-12 17:00', TZ, NOW), fromZoned(2026, 12, 12, 17, 0, TZ))
    assert.strictEqual(parseDue('dec 12', TZ, NOW), fromZoned(2026, 12, 12, 23, 59, TZ))
    assert.strictEqual(parseDue('12th December at 5pm', TZ, NOW), fromZoned(2026, 12, 12, 17, 0, TZ))
    assert.strictEqual(parseDue('on Dec 3, 2026 at 9:30am', TZ, NOW), fromZoned(2026, 12, 3, 9, 30, TZ))
  })
  it('rolls a past month and day into next year, and rejects past or repeating dates', () => {
    assert.strictEqual(parseDue('jan 10', TZ, NOW), fromZoned(2027, 1, 10, 23, 59, TZ))
    assert.strictEqual(parseDue('2026-01-10', TZ, NOW), undefined)
    assert.strictEqual(parseDue('every friday', TZ, NOW), undefined)
    assert.strictEqual(parseDue('feb 30 at noonish', TZ, NOW), undefined)
  })
  it('falls back to relative times', () => {
    assert.strictEqual(parseDue('in 3 days', TZ, NOW), NOW + 3 * DAY_MS)
  })
})

describe('Deadlines', () => {
  const state = setupRobot('Deadlines.ts')
  beforeEach(() => {
    policyFor(state.robot).update(d => { d.guilds.g1 = { mode: 'professional', on: [], off: [] } })
  })

  it('lets staff add and remove deadlines, and anyone list them', async () => {
    const say = sayer(state.robot)
    const sent = collect(state.robot)
    await say('u1', 'deadline HW3 due 2099-01-01')
    assert.strictEqual(sent.at(-1), 'Only someone who can manage this channel can do that.')
    await say('u1', 'deadline HW3 due in 3 days', { staff: true })
    assert.match(sent.at(-1)!, /^📅 \*\*HW3\*\* is due .+\. I'll post a reminder the day before\.$/)
    await say('u1', 'deadline Quiz due in 2 hours', { staff: true })
    assert.doesNotMatch(sent.at(-1)!, /reminder/)
    await say('u1', 'deadline Nope due someday', { staff: true })
    assert.match(sent.at(-1)!, /couldn't tell when/)
    await say('u2', 'deadlines')
    assert.match(sent.at(-1)!, /^1\. \*\*Quiz\*\*: .+\n2\. \*\*HW3\*\*: /)
    await say('u2', 'deadlines', { room: 'other' })
    assert.match(sent.at(-1)!, /^No deadlines here/)
    await say('u2', 'remove deadline 1')
    assert.strictEqual(sent.at(-1), 'Only someone who can manage this channel can do that.')
    await say('u1', 'remove deadline 1', { staff: true })
    assert.strictEqual(sent.at(-1), 'Removed **Quiz**.')
    await say('u1', 'remove deadline 5', { staff: true })
    assert.match(sent.at(-1)!, /no deadline 5/)
  })

  it('reminds the day before, then says when it is due', async () => {
    const { robot } = state
    await sayer(robot)('u1', 'deadline HW3 due in 3 days', { staff: true })
    const sent = collect(robot)
    const fire = () => runDueJobs(robot, 'deadline')
    await fire()
    assert.match(sent.at(-1)!, /^⏰ Reminder: \*\*HW3\*\* is due /)
    const [job] = robot.brain.get<{ data: { stage: string } }[]>('schedule:deadline')!
    assert.strictEqual(job!.data.stage, 'due')
    // pretend the due time came
    robot.brain.set('schedule:deadline', [{ ...job, data: { ...job!.data, due: Date.now() } }])
    await fire()
    assert.strictEqual(sent.at(-1), '📌 **HW3** is due now.')
    assert.deepStrictEqual(robot.brain.get('schedule:deadline'), [])
  })
})
