import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { parseReport } from '../scripts/Standup.ts'
import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { clock, runDueJobs } from './helpers/fakes.ts'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// any thanks line for who, then the fixed tail
const thanked = (line: string | undefined, who: string, tail = '') =>
  assert.match(line!, new RegExp(`^✅ .*${esc(who)}[^\\n]*?${esc(tail)}$`))

describe('Standup', () => {
  // alice (u1) owns the bot
  const state = setupRobot('Standup.ts', { owner: 'u1' })
  const fireNow = (name: string) => runDueJobs(state.robot, name)
  const people = () => {
    const c = chat(state, { id: 'u1', name: 'alice', room: 'room' })
    const bob = brainUser(c.robot, 'u2', 'bob')
    return { ...c, bob }
  }

  it('parses the four sections, in any layout', () => {
    assert.deepStrictEqual(parseReport('DONE: fixed ci\nNEXT: docs\nBLOCKERS: none\nDISCUSS: release date'), { done: 'fixed ci', next: 'docs', discuss: 'release date' })
    assert.deepStrictEqual(parseReport('done: a / next: b / blockers: waiting on creds'), { done: 'a', next: 'b', blockers: 'waiting on creds' })
    assert.deepStrictEqual(parseReport('yesterday: x today: y stuck: z questions: w'), { done: 'x', next: 'y', blockers: 'z', discuss: 'w' })
    assert.deepStrictEqual(parseReport('Done: refactor; did: tests next: n/a'), { done: 'refactor; tests' })
    assert.deepStrictEqual(parseReport('blocked on review'), { done: 'blocked on review' })
    assert.deepStrictEqual(parseReport('none'), {})
  })
  it('schedules a weekly standup in the setter\'s timezone, summary a day later by default', async () => {
    const { robot, sent, ask } = people()
    robot.brain.set('tz:user:u1', 'America/Chicago')
    await ask('standup every monday at 10am')
    assert.match(sent[0]!, /^Standup set for every Monday at 10am \(America\/Chicago\), summary 1d later\. First one is /)
    await ask('standup')
    assert.match(sent[1]!, /^Standup runs every Monday at 10am \(America\/Chicago\), next /)
    assert.strictEqual(robot.brain.get<{ tz: string }[]>('schedule:standup')![0]!.tz, 'America/Chicago')
    await ask('standup every friday at 2pm, summary after 3 hours')
    assert.match(sent[2]!, /^Standup set for every Friday at 2pm \(America\/Chicago\), summary 3h later\./)
    assert.strictEqual(robot.brain.get<unknown[]>('schedule:standup')!.length, 1)
    await ask('standup every friday at 2pm summary after 10 days')
    assert.match(sent[3]!, /^The summary can come between/)
    await ask('standup every 2 hours')
    assert.match(sent[4]!, /^Try something like/)
  })
  it('keeps one round open across days, and takes late check-ins without a second summary', async () => {
    const { robot, sent, say, ask, bob } = people()
    await ask('standup every monday at 10am')
    await fireNow('standup')
    assert.match(sent[1]!, /Check in any time, summary /)
    await say('standup: DONE: a NEXT: b')
    const t = clock()
    t.advance(2 * 86_400_000)
    await say('standup: DONE: c NEXT: d', { user: bob })
    await ask('standup')
    assert.match(sent[4]!, /2 checked in this round: <@u1>, <@u2>\./)
    mock.restoreAll()
    await fireNow('standup-summary')
    assert.match(sent[5]!, /^📋 Standup summary \(2 check-ins\)/)
    const carol = brainUser(robot, 'u3', 'carol')
    await say('standup: DONE: e NEXT: f', { user: carol })
    thanked(sent[6], '<@u3>', ' The summary already went out; `standup summary` shows it with yours.')
    await ask('standup summary', { user: carol })
    assert.match(sent[7]!, /\(3 check-ins\)/)
    await fireNow('standup')
    // straight to the next prompt, no mini summary
    assert.match(sent[8]!, /Check in any time/)
    assert.strictEqual(sent.length, 9)
  })
  it('counts standup streaks in weeks', async () => {
    const { robot, sent, say } = people()
    const t = clock()
    for (let week = 0; week < 3; week++) {
      robot.brain.remove('standup:round:room')
      await say('standup: DONE: x NEXT: y')
      t.advance(7 * 86_400_000)
    }
    assert.match(sent[2]!, /^✅ .*<@u1>.*\n🔥 .*<@u1>.*3-week/)
  })
  it('prompts, collects check-ins and posts a summary with blockers and topics', async () => {
    const { robot, sent, say, ask, bob } = people()
    await ask('standup every monday at 9am')
    await fireNow('standup')
    assert.match(sent[1]!, /DONE: what you finished\nNEXT: what you're on next\nBLOCKERS: anything in your way\nDISCUSS: anything to talk through/)

    await say('standup:\nDONE: fixed the build\nNEXT: docs\nBLOCKERS: none')
    thanked(sent[2], '<@u1>')
    await ask('standup: done: reviews / next: deploy / blockers: staging access / discuss: release date', { user: bob })
    thanked(sent[3], '<@u2>', " Sorry about the blocker, it'll be in the summary. Added to the discussion list.")
    await say('standup: DONE: fixed the build NEXT: tests')
    assert.strictEqual(sent[4], 'Updated your check-in.')

    await fireNow('standup-summary')
    assert.strictEqual(sent[5], [
      '📋 Standup summary (2 check-ins)',
      '',
      '<@u2>\n  **DONE:** reviews\n  **NEXT:** deploy\n<@u1>\n  **DONE:** fixed the build\n  **NEXT:** tests',
      '',
      '🚧 **BLOCKERS**\n• <@u2>: staging access',
      '',
      '💬 **DISCUSS**\n• <@u2>: release date'
    ].join('\n'))
    assert.deepStrictEqual(robot.brain.get<{ userId: string }[]>('log:standup')!.map(e => e.userId), ['u1', 'u2'])
  })
  it('asks for the sections when a check-in has none', async () => {
    const { sent, say } = people()
    await say('standup: none')
    assert.match(sent[0]!, /^Use the four sections/)
    await say('standup: next: planning')
    thanked(sent[1], '<@u1>', ' No DONE? Re-post to add it.')
  })
  it('lets only channel managers change the schedule', async () => {
    const { robot, sent, ask, bob } = people()
    await ask('standup every monday at 10am', { user: bob })
    assert.strictEqual(sent[0], 'Only someone who can manage this channel can do that.')
    assert.strictEqual(robot.brain.get('schedule:standup'), null)
    await ask('standup every monday at 10am')
    for (const cmd of ['standup skip', 'standup unskip', 'standup off']) await ask(`${cmd}`, { user: bob })
    assert.deepStrictEqual(sent.slice(2), Array(3).fill('Only someone who can manage this channel can do that.'))
    assert.strictEqual(robot.brain.get<unknown[]>('schedule:standup')!.length, 1)
    await ask('standup', { user: bob })
    assert.match(sent[5]!, /^Standup runs every Monday/)
  })
  it('stops the standup', async () => {
    const { robot, sent, ask } = people()
    await ask('standup off')
    assert.strictEqual(sent[0], 'This channel has no standup scheduled.')
    await ask('standup every monday at 9')
    await ask('standup off')
    assert.strictEqual(sent[2], 'Standup stopped for this channel.')
    assert.deepStrictEqual(robot.brain.get('schedule:standup'), [])
  })
  it('summarizes on demand, including nobody', async () => {
    const { sent, say, ask } = people()
    await ask('standup summary')
    assert.strictEqual(sent[0], 'No standup has run here yet.')
    await say('standup: DONE: x NEXT: y')
    await ask('standup summary')
    assert.strictEqual(sent[2], '📋 Standup summary (1 check-in)\n\n<@u1>\n  **DONE:** x\n  **NEXT:** y\n\n🚧 No blockers. 🎉')
  })
  it('pings last round\'s people who have not checked in before the summary', async () => {
    const { robot, sent, say, ask, bob } = people()
    brainUser(robot, 'u3', 'carol')
    await ask('standup every monday at 10am')
    await fireNow('standup')
    // first round has nobody to expect
    assert.strictEqual((robot.brain.get<unknown[]>('schedule:standup-reminder') ?? []).length, 0)
    await say('standup: DONE: a NEXT: b')
    await say('standup: DONE: c NEXT: d', { user: bob })
    await fireNow('standup')
    const reminder = robot.brain.get<{ at: number }[]>('schedule:standup-reminder')![0]!
    const summary = robot.brain.get<{ at: number }[]>('schedule:standup-summary')![0]!
    assert.strictEqual(summary.at - reminder.at, 2 * 3_600_000)
    await say('standup: DONE: e NEXT: f', { user: bob })
    const before = sent.length
    await fireNow('standup-reminder')
    assert.strictEqual(sent.length, before + 1)
    assert.match(sent.at(-1)!, /^⏰ .*(<@u1>.*(1d|23h \d+m)|(1d|23h \d+m).*<@u1>).*`standup: DONE: … NEXT: …`$/)
  })
  it('skips the ping when everyone expected has checked in, and on short rounds pings halfway', async () => {
    const { robot, sent, say, ask } = people()
    await ask('standup every monday at 10am, summary after 1 hour')
    await fireNow('standup')
    await say('standup: DONE: a NEXT: b')
    await fireNow('standup')
    const reminder = robot.brain.get<{ at: number }[]>('schedule:standup-reminder')![0]!
    const summary = robot.brain.get<{ at: number }[]>('schedule:standup-summary')![0]!
    assert.strictEqual(summary.at - reminder.at, 30 * 60_000)
    await say('standup: DONE: c NEXT: d')
    const before = sent.length
    await fireNow('standup-reminder')
    assert.strictEqual(sent.length, before)
  })
  it('skips a week without breaking streaks, once', async () => {
    const { robot, sent, say, ask } = people()
    await ask('standup skip')
    assert.strictEqual(sent[0], 'This channel has no standup scheduled.')
    await ask('standup every monday at 10am')
    await fireNow('standup')
    await say('standup: DONE: a NEXT: b')
    await ask('standup skip')
    assert.match(sent.at(-1)!, /^Skipping the standup on .+ Streaks will be paused, not broken\./)
    await ask('standup')
    assert.match(sent.at(-1)!, /\(skipped\)\./)

    const t = clock()
    t.advance(7 * 86_400_000)
    const before = sent.length
    await fireNow('standup')
    // pending summary, then skip notice
    assert.match(sent[before]!, /^📋 Standup summary/)
    assert.strictEqual(sent[before + 1], '🏖️ No standup this week. Streaks are paused, not broken.')
    assert.strictEqual(robot.brain.get<{ data: { skip?: boolean } }[]>('schedule:standup')![0]!.data.skip, false)

    t.advance(7 * 86_400_000)
    await fireNow('standup')
    assert.match(sent.at(-1)!, /Check in any time/)
    await say('standup: DONE: c NEXT: d')
    assert.strictEqual(robot.brain.get<{ current: number }>('streak:standup:u1')!.current, 2)
  })
  it('undoes a skip', async () => {
    const { robot, sent, ask } = people()
    await ask('standup every monday at 10am')
    await ask('standup skip next week')
    await ask('standup unskip')
    assert.match(sent[2]!, /is back on\.$/)
    assert.strictEqual(robot.brain.get<{ data: { skip?: boolean } }[]>('schedule:standup')![0]!.data.skip, false)
  })
  it('counts streaks by round, so a round spanning two weeks keeps them', async () => {
    const { robot, say } = people()
    // friday 6 nov and friday 13 nov 2026, noon utc
    const fri1 = Date.UTC(2026, 10, 6, 12)
    const fri2 = Date.UTC(2026, 10, 13, 12)
    const t = clock(fri1)
    robot.brain.set('standup:round:room', { startedAt: fri1, checkIns: [], prompted: true })
    await say('standup: DONE: a NEXT: b')
    robot.brain.set('standup:round:room', { startedAt: fri2, checkIns: [], prompted: true })
    // monday 23 nov, still the round that started on the 13th
    t.set(Date.UTC(2026, 10, 23, 9))
    await say('standup: DONE: c NEXT: d')
    assert.strictEqual(robot.brain.get<{ current: number }>('streak:standup:u1')!.current, 2)
  })
  it('uses up a skip that passed while the bot was down', async () => {
    const { robot, ask } = people()
    await ask('standup every monday at 10am')
    await ask('standup skip')
    const [job] = robot.brain.get<{ at: number, data: { skip: boolean } }[]>('schedule:standup')!
    // pretend the skipped prompt was three days ago
    robot.brain.set('schedule:standup', [{ ...job, at: Date.now() - 3 * 86_400_000 }])
    robot.brain.emit('connected')
    const [after] = robot.brain.get<{ at: number, data: { skip: boolean } }[]>('schedule:standup')!
    assert.strictEqual(after!.data.skip, false)
    assert.ok(after!.at > Date.now())
  })
})
