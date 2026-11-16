import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { parseReport } from '../scripts/Standup.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// make the stored job due and re-arm it
const fireNow = async (robot: Parameters<typeof collect>[0], name: string) => {
  const jobs = robot.brain.get<{ at: number }[]>(`schedule:${name}`)!
  robot.brain.set(`schedule:${name}`, jobs.map(j => ({ ...j, at: Date.now() })))
  robot.brain.emit('connected')
  await tick(30)
}

describe('Standup', () => {
  const state = setupRobot('Standup.ts', { envVars: ['OWNER_USER_ID'] })
  // alice (u1) owns the bot
  beforeEach(() => { process.env.OWNER_USER_ID = 'u1' })

  it('parses the four sections, in any layout', () => {
    assert.deepEqual(parseReport('DONE: fixed ci\nNEXT: docs\nBLOCKERS: none\nDISCUSS: release date'), { done: 'fixed ci', next: 'docs', discuss: 'release date' })
    assert.deepEqual(parseReport('done: a / next: b / blockers: waiting on creds'), { done: 'a', next: 'b', blockers: 'waiting on creds' })
    assert.deepEqual(parseReport('yesterday: x today: y stuck: z questions: w'), { done: 'x', next: 'y', blockers: 'z', discuss: 'w' })
    assert.deepEqual(parseReport('Done: refactor; did: tests next: n/a'), { done: 'refactor; tests' })
    assert.deepEqual(parseReport('blocked on review'), { done: 'blocked on review' })
    assert.deepEqual(parseReport('none'), {})
  })
  it('schedules a weekly standup in the setter\'s timezone, summary a day later by default', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    robot.brain.set('tz:user:u1', 'America/Chicago')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant standup every monday at 10am', 'room')
    assert.match(sent[0]!, /^Standup set for every Monday at 10am \(America\/Chicago\), summary 1d later\. First one is /)
    await robot.adapter.say(user, '@Dumbotheelephant standup', 'room')
    assert.match(sent[1]!, /^Standup runs every Monday at 10am \(America\/Chicago\), next /)
    assert.equal(robot.brain.get<{ tz: string }[]>('schedule:standup')![0]!.tz, 'America/Chicago')
    await robot.adapter.say(user, '@Dumbotheelephant standup every friday at 2pm, summary after 3 hours', 'room')
    assert.match(sent[2]!, /^Standup set for every Friday at 2pm \(America\/Chicago\), summary 3h later\./)
    assert.equal(robot.brain.get<unknown[]>('schedule:standup')!.length, 1)
    await robot.adapter.say(user, '@Dumbotheelephant standup every friday at 2pm summary after 10 days', 'room')
    assert.match(sent[3]!, /^The summary can come between/)
    await robot.adapter.say(user, '@Dumbotheelephant standup every 2 hours', 'room')
    assert.match(sent[4]!, /^Try something like/)
  })
  it('keeps one round open across days, and takes late check-ins without a second summary', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const alice = brainUser(robot, 'u1', 'alice')
    const bob = brainUser(robot, 'u2', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 10am', 'room')
    await fireNow(robot, 'standup')
    assert.match(sent[1]!, /Check in any time, summary /)
    await robot.adapter.say(alice, 'standup: DONE: a NEXT: b', 'room')
    const start = Date.now()
    mock.method(Date, 'now', () => start + 2 * 86_400_000)
    await robot.adapter.say(bob, 'standup: DONE: c NEXT: d', 'room')
    await robot.adapter.say(alice, '@Dumbotheelephant standup', 'room')
    assert.match(sent[4]!, /2 checked in this round: <@u1>, <@u2>\./)
    mock.restoreAll()
    await fireNow(robot, 'standup-summary')
    assert.match(sent[5]!, /^📋 Standup summary \(2 check-ins\)/)
    const carol = brainUser(robot, 'u3', 'carol')
    await robot.adapter.say(carol, 'standup: DONE: e NEXT: f', 'room')
    assert.equal(sent[6], '✅ Noted, <@u3>. The summary already went out; `standup summary` shows it with yours.')
    await robot.adapter.say(carol, '@Dumbotheelephant standup summary', 'room')
    assert.match(sent[7]!, /\(3 check-ins\)/)
    await fireNow(robot, 'standup')
    // straight to the next prompt, no mini summary
    assert.match(sent[8]!, /^(📋 Weekly standup!|☕|🗓️)/)
    assert.equal(sent.length, 9)
  })
  it('counts standup streaks in weeks', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    const start = Date.now()
    for (let week = 0; week < 3; week++) {
      mock.method(Date, 'now', () => start + week * 7 * 86_400_000)
      robot.brain.remove('standup:round:room')
      await robot.adapter.say(user, 'standup: DONE: x NEXT: y', 'room')
      mock.restoreAll()
    }
    assert.equal(sent[2], '✅ Noted, <@u1>.\n🔥 <@u1> is on a 3-week standup streak!')
  })
  it('prompts, collects check-ins and posts a summary with blockers and topics', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const alice = brainUser(robot, 'u1', 'alice')
    const bob = brainUser(robot, 'u2', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 9am', 'room')
    await fireNow(robot, 'standup')
    assert.match(sent[1]!, /DONE: what you finished\nNEXT: what you're on next\nBLOCKERS: anything in your way\nDISCUSS: anything to talk through/)

    await robot.adapter.say(alice, 'standup:\nDONE: fixed the build\nNEXT: docs\nBLOCKERS: none', 'room')
    assert.equal(sent[2], '✅ Thanks <@u1>!')
    await robot.adapter.say(bob, '@Dumbotheelephant standup: done: reviews / next: deploy / blockers: staging access / discuss: release date', 'room')
    assert.equal(sent[3], "✅ Got it, <@u2>. Sorry about the blocker, it'll be in the summary. Added to the discussion list.")
    await robot.adapter.say(alice, 'standup: DONE: fixed the build NEXT: tests', 'room')
    assert.equal(sent[4], 'Updated your check-in.')

    await fireNow(robot, 'standup-summary')
    assert.equal(sent[5], [
      '📋 Standup summary (2 check-ins)',
      '',
      '<@u2>\n  **DONE:** reviews\n  **NEXT:** deploy\n<@u1>\n  **DONE:** fixed the build\n  **NEXT:** tests',
      '',
      '🚧 **BLOCKERS**\n• <@u2>: staging access',
      '',
      '💬 **DISCUSS**\n• <@u2>: release date'
    ].join('\n'))
    assert.deepEqual(robot.brain.get<{ userId: string }[]>('log:standup')!.map(e => e.userId), ['u1', 'u2'])
  })
  it('asks for the sections when a check-in has none', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, 'standup: none', 'room')
    assert.match(sent[0]!, /^Use the four sections/)
    await robot.adapter.say(user, 'standup: next: planning', 'room')
    assert.equal(sent[1], '✅ Thanks <@u1>! No DONE? Re-post to add it.')
  })
  it('lets only the owner change the schedule', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    const bob = brainUser(robot, 'u2', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(bob, '@Dumbotheelephant standup every monday at 10am', 'room')
    assert.equal(sent[0], 'Only my owner can do that.')
    assert.equal(robot.brain.get('schedule:standup'), null)
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 10am', 'room')
    for (const cmd of ['standup skip', 'standup unskip', 'standup off']) await robot.adapter.say(bob, `@Dumbotheelephant ${cmd}`, 'room')
    assert.deepEqual(sent.slice(2), Array(3).fill('Only my owner can do that.'))
    assert.equal(robot.brain.get<unknown[]>('schedule:standup')!.length, 1)
    await robot.adapter.say(bob, '@Dumbotheelephant standup', 'room')
    assert.match(sent[5]!, /^Standup runs every Monday/)
  })
  it('stops the standup', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant standup off', 'room')
    assert.equal(sent[0], 'This channel has no standup scheduled.')
    await robot.adapter.say(user, '@Dumbotheelephant standup every monday at 9', 'room')
    await robot.adapter.say(user, '@Dumbotheelephant standup off', 'room')
    assert.equal(sent[2], 'Standup stopped for this channel.')
    assert.deepEqual(robot.brain.get('schedule:standup'), [])
  })
  it('summarizes on demand, including nobody', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant standup summary', 'room')
    assert.equal(sent[0], 'No standup has run here yet.')
    await robot.adapter.say(user, 'standup: DONE: x NEXT: y', 'room')
    await robot.adapter.say(user, '@Dumbotheelephant standup summary', 'room')
    assert.equal(sent[2], '📋 Standup summary (1 check-in)\n\n<@u1>\n  **DONE:** x\n  **NEXT:** y\n\n🚧 No blockers. 🎉')
  })
  it('pings last round\'s people who have not checked in before the summary', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const alice = brainUser(robot, 'u1', 'alice')
    const bob = brainUser(robot, 'u2', 'bob')
    brainUser(robot, 'u3', 'carol')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 10am', 'room')
    await fireNow(robot, 'standup')
    // first round has nobody to expect
    assert.equal((robot.brain.get<unknown[]>('schedule:standup-reminder') ?? []).length, 0)
    await robot.adapter.say(alice, 'standup: DONE: a NEXT: b', 'room')
    await robot.adapter.say(bob, 'standup: DONE: c NEXT: d', 'room')
    await fireNow(robot, 'standup')
    const reminder = robot.brain.get<{ at: number }[]>('schedule:standup-reminder')![0]!
    const summary = robot.brain.get<{ at: number }[]>('schedule:standup-summary')![0]!
    assert.equal(summary.at - reminder.at, 2 * 3_600_000)
    await robot.adapter.say(bob, 'standup: DONE: e NEXT: f', 'room')
    const before = sent.length
    await fireNow(robot, 'standup-reminder')
    assert.equal(sent.length, before + 1)
    assert.match(sent.at(-1)!, /^⏰ Standup summary in (1d|23h \d+m)\. Still waiting on <@u1>: `standup: DONE: … NEXT: …`$/)
  })
  it('skips the ping when everyone expected has checked in, and on short rounds pings halfway', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 10am, summary after 1 hour', 'room')
    await fireNow(robot, 'standup')
    await robot.adapter.say(alice, 'standup: DONE: a NEXT: b', 'room')
    await fireNow(robot, 'standup')
    const reminder = robot.brain.get<{ at: number }[]>('schedule:standup-reminder')![0]!
    const summary = robot.brain.get<{ at: number }[]>('schedule:standup-summary')![0]!
    assert.equal(summary.at - reminder.at, 30 * 60_000)
    await robot.adapter.say(alice, 'standup: DONE: c NEXT: d', 'room')
    const before = sent.length
    await fireNow(robot, 'standup-reminder')
    assert.equal(sent.length, before)
  })
  it('varies the thanks without repeating back to back', async () => {
    const { robot } = state
    const sent = collect(robot)
    for (let i = 0; i < 30; i++) await robot.adapter.say(brainUser(robot, `p${i}`, `person ${i}`), 'standup: DONE: x NEXT: y', 'room')
    const thanks = sent.map(t => t.split('\n')[0]!.replace(/<@p\d+>/, '@x'))
    thanks.forEach((t, i) => { if (i) assert.notEqual(t, thanks[i - 1]) })
  })
  it('skips a week without breaking streaks, once', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const alice = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant standup skip', 'room')
    assert.equal(sent[0], 'This channel has no standup scheduled.')
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 10am', 'room')
    await fireNow(robot, 'standup')
    await robot.adapter.say(alice, 'standup: DONE: a NEXT: b', 'room')
    const start = Date.now()
    await robot.adapter.say(alice, '@Dumbotheelephant standup skip', 'room')
    assert.match(sent.at(-1)!, /^Skipping the standup on .+ Streaks will be paused, not broken\./)
    await robot.adapter.say(alice, '@Dumbotheelephant standup', 'room')
    assert.match(sent.at(-1)!, /\(skipped\)\./)

    mock.method(Date, 'now', () => start + 7 * 86_400_000)
    const before = sent.length
    await fireNow(robot, 'standup')
    // the pending summary goes out, then the skip notice instead of a prompt
    assert.match(sent[before]!, /^📋 Standup summary/)
    assert.equal(sent[before + 1], '🏖️ No standup this week. Streaks are paused, not broken.')
    assert.equal(robot.brain.get<{ data: { skip?: boolean } }[]>('schedule:standup')![0]!.data.skip, false)

    mock.method(Date, 'now', () => start + 14 * 86_400_000)
    await fireNow(robot, 'standup')
    assert.match(sent.at(-1)!, /Check in any time/)
    await robot.adapter.say(alice, 'standup: DONE: c NEXT: d', 'room')
    assert.equal(robot.brain.get<{ current: number }>('streak:standup:u1')!.current, 2)
  })
  it('undoes a skip', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 10am', 'room')
    await robot.adapter.say(alice, '@Dumbotheelephant standup skip next week', 'room')
    await robot.adapter.say(alice, '@Dumbotheelephant standup unskip', 'room')
    assert.match(sent[2]!, /is back on\.$/)
    assert.equal(robot.brain.get<{ data: { skip?: boolean } }[]>('schedule:standup')![0]!.data.skip, false)
  })
  it('counts streaks by round, so a round spanning two weeks keeps them', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const alice = brainUser(robot, 'u1', 'alice')
    // friday 6 nov and friday 13 nov 2026, noon utc
    const fri1 = Date.UTC(2026, 10, 6, 12)
    const fri2 = Date.UTC(2026, 10, 13, 12)
    const now = mock.method(Date, 'now', () => fri1)
    robot.brain.set('standup:round:room', { startedAt: fri1, checkIns: [], prompted: true })
    await robot.adapter.say(alice, 'standup: DONE: a NEXT: b', 'room')
    robot.brain.set('standup:round:room', { startedAt: fri2, checkIns: [], prompted: true })
    // monday 23 nov, still the round that started on the 13th
    now.mock.mockImplementation(() => Date.UTC(2026, 10, 23, 9))
    await robot.adapter.say(alice, 'standup: DONE: c NEXT: d', 'room')
    assert.equal(robot.brain.get<{ current: number }>('streak:standup:u1')!.current, 2)
  })
  it('uses up a skip that passed while the bot was down', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    await robot.adapter.say(alice, '@Dumbotheelephant standup every monday at 10am', 'room')
    await robot.adapter.say(alice, '@Dumbotheelephant standup skip', 'room')
    const [job] = robot.brain.get<{ at: number, data: { skip: boolean } }[]>('schedule:standup')!
    // pretend the skipped prompt was three days ago
    robot.brain.set('schedule:standup', [{ ...job, at: Date.now() - 3 * 86_400_000 }])
    robot.brain.emit('connected')
    const [after] = robot.brain.get<{ at: number, data: { skip: boolean } }[]>('schedule:standup')!
    assert.equal(after!.data.skip, false)
    assert.ok(after!.at > Date.now())
  })
})
