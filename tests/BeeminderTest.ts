import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import type { User } from 'hubot'

import {
  colorOf, dueZenoStep, isQuiet, nextPollAt, openToken, parseQuiet, quietEnd, sealToken, turnsRedAt, unitsFor, zenoTimes
} from '../scripts/lib/beeminder.ts'
import type { Datapoint, Goal } from '../scripts/lib/beeminder.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { HOUR_MS, MINUTE_MS } from '../scripts/lib/time.ts'
import { setupRobot, brainUser, collectRooms } from './helpers/setup.ts'
import { clock, runDueJobs, tick, withEnv, withMessage } from './helpers/fakes.ts'
import { fc, zone } from './helpers/arb.ts'
import type { TestRobot } from './helpers/setup.ts'

const ENV = ['BEEMINDER_TOKEN_KEY', 'BEEMINDER_MAX_POLL_HOURS', 'BEEMINDER_ZENO_START_HOURS', 'BEEMINDER_QUIET_HOURS']
const KEY = Buffer.alloc(32, 7).toString('base64')
const TOKEN = 'abcDEF123_tok'
const NOW = Date.parse('2026-11-17T12:00:00Z')
// 11:59pm london today
const TONIGHT = Date.parse('2026-11-17T23:59:00Z')

const goal = (slug: string, extra: Partial<Goal> = {}): Goal => ({
  slug, losedate: TONIGHT / 1000 + 3 * 86_400, safebuf: 3, roadstatuscolor: 'green', baremin: '+1', gunits: 'pushups', gunits_singular: 'pushup', ...extra
})

const redGoal = (slug: string, extra: Partial<Goal> = {}): Goal =>
  goal(slug, { losedate: TONIGHT / 1000, safebuf: 0, roadstatuscolor: 'red', baremin: '+3', ...extra })

interface Fake {
  goals: Goal[]
  datapoints: Datapoint[]
  status: number
  calls: string[]
}

// fake beeminder api; one account, ada
const fakeBeeminder = (): Fake => {
  const fake: Fake = { goals: [], datapoints: [], status: 200, calls: [] }
  mock.method(global, 'fetch', async (url: string) => {
    const u = new URL(url)
    fake.calls.push(u.pathname + u.search)
    if (u.searchParams.get('auth_token') !== TOKEN || fake.status === 401) return new Response('{"errors":{}}', { status: 401 })
    if (fake.status !== 200) return new Response('{}', { status: fake.status })
    if (u.pathname === '/api/v1/users/me.json') return Response.json({ username: 'ada', timezone: 'Europe/London' })
    if (u.pathname === '/api/v1/users/ada/goals.json') return Response.json(fake.goals)
    if (/\/datapoints\.json$/.test(u.pathname)) return Response.json(fake.datapoints)
    return new Response('{}', { status: 404 })
  })
  return fake
}

const dm = (user: User) => withMessage(user, { guildId: null })
const channel = (user: User, extra: Record<string, unknown> = {}) => withMessage(user, { guildId: 'g1', ...extra })

const say = async (robot: TestRobot, user: User, text: string, room: string) => {
  await robot.adapter.say(user, `@${robot.name} ${text}`, room)
  await tick(20)
}

const jobs = (robot: TestRobot) => robot.brain.get<{ id: string, at: number }[]>('schedule:bee') ?? []

// sync env swap
const withEnvSync = <T>(vars: Record<string, string>, fn: () => T): T => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

// fire the poll job now
const pollNow = (robot: TestRobot) => runDueJobs(robot, 'bee')

describe('beeminder lib', () => {
  it('halves the gap between zeno alerts', () => {
    const times = zenoTimes(TONIGHT, 8 * HOUR_MS, 5 * MINUTE_MS).map(t => (TONIGHT - t) / MINUTE_MS)
    assert.deepStrictEqual(times, [480, 240, 120, 60, 30, 15, 7.5])
    assert.strictEqual(dueZenoStep(TONIGHT - 9 * HOUR_MS, TONIGHT), -1)
    assert.strictEqual(dueZenoStep(TONIGHT - 3 * HOUR_MS, TONIGHT), 1)
    assert.strictEqual(dueZenoStep(TONIGHT - MINUTE_MS, TONIGHT), 6)
    assert.strictEqual(dueZenoStep(TONIGHT + MINUTE_MS, TONIGHT), -1)
  })

  it('turns red a wall-clock day before the deadline, across dst', () => {
    assert.strictEqual(turnsRedAt(TONIGHT, 'Europe/London'), TONIGHT - 24 * HOUR_MS)
    // clocks went back on 2026-10-25 in london
    const after = Date.parse('2026-10-25T23:59:00Z')
    assert.strictEqual(turnsRedAt(after, 'Europe/London'), Date.parse('2026-10-24T22:59:00Z'))
  })

  it('polls at the soonest of zeno, deadline, turning red and the cap', () => {
    const opts = { maxMs: 24 * HOUR_MS }
    // red, 11h59m left: zeno at 8h before
    assert.strictEqual(nextPollAt([redGoal('a')], NOW, 'Europe/London', opts), TONIGHT - 8 * HOUR_MS)
    // red, 3h left: next zeno at 2h before
    assert.strictEqual(nextPollAt([redGoal('a')], TONIGHT - 3 * HOUR_MS, 'Europe/London', opts), TONIGHT - 2 * HOUR_MS)
    // past the last zeno: just after the deadline
    assert.strictEqual(nextPollAt([redGoal('a')], TONIGHT - MINUTE_MS, 'Europe/London', opts), TONIGHT + 2 * MINUTE_MS)
    // orange, red tonight, cap first
    const orange = goal('b', { losedate: TONIGHT / 1000 + 86_400, safebuf: 1, roadstatuscolor: 'orange' })
    assert.strictEqual(nextPollAt([orange], NOW, 'Europe/London', { maxMs: 2 * HOUR_MS }), NOW + 2 * HOUR_MS)
    assert.strictEqual(nextPollAt([orange], TONIGHT - HOUR_MS, 'Europe/London', opts), TONIGHT + MINUTE_MS)
    assert.strictEqual(nextPollAt([], NOW, 'Europe/London', opts), NOW + 24 * HOUR_MS)
    // derail pending
    assert.strictEqual(nextPollAt([redGoal('a')], TONIGHT + HOUR_MS, 'Europe/London', opts), TONIGHT + HOUR_MS + 30 * MINUTE_MS)
  })

  it('shows units, singular for one, none for hh:mm amounts', () => {
    assert.strictEqual(unitsFor(goal('a'), '+3'), ' pushups')
    assert.strictEqual(unitsFor(goal('a'), '-1'), ' pushup')
    assert.strictEqual(unitsFor(goal('a', { gunits: 'minutes' }), '+01:17:10'), '')
    assert.strictEqual(unitsFor(goal('a', { gunits: undefined }), '+3'), '')
  })

  it('knows quiet hours, across midnight', () => {
    const quiet = parseQuiet(undefined)!
    assert.deepStrictEqual(quiet, { start: 1, end: 8 })
    assert.deepStrictEqual(parseQuiet('22-7'), { start: 22, end: 7 })
    assert.strictEqual(parseQuiet('off'), undefined)
    assert.ok(!isQuiet(Date.parse('2026-11-17T23:30:00Z'), 'Europe/London', quiet))
    assert.ok(!isQuiet(Date.parse('2026-11-18T00:30:00Z'), 'Europe/London', quiet))
    assert.ok(isQuiet(Date.parse('2026-11-17T23:30:00Z'), 'Europe/London', parseQuiet('23-8')))
    assert.ok(isQuiet(Date.parse('2026-11-18T03:00:00Z'), 'Europe/London', quiet))
    assert.ok(!isQuiet(Date.parse('2026-11-18T08:00:00Z'), 'Europe/London', quiet))
    assert.ok(!isQuiet(NOW, 'Europe/London', quiet))
    assert.ok(!isQuiet(Date.parse('2026-11-18T03:00:00Z'), 'Europe/London', undefined))
    assert.strictEqual(quietEnd(Date.parse('2026-11-18T01:30:00Z'), 'Europe/London', quiet), Date.parse('2026-11-18T08:00:00Z'))
    assert.strictEqual(quietEnd(Date.parse('2026-11-18T03:00:00Z'), 'Europe/London', quiet), Date.parse('2026-11-18T08:00:00Z'))
  })

  it('reads colors, falling back to safe days', () => {
    assert.strictEqual(colorOf(goal('a', { roadstatuscolor: 'dkgreen' })), 'green')
    assert.strictEqual(colorOf(goal('a', { roadstatuscolor: undefined, colorkey: 'blue' })), 'blue')
    assert.strictEqual(colorOf(goal('a', { roadstatuscolor: undefined, safebuf: 0 })), 'red')
    assert.strictEqual(colorOf(goal('a', { roadstatuscolor: undefined, safebuf: 1 })), 'orange')
    assert.strictEqual(colorOf(goal('a', { roadstatuscolor: undefined, safebuf: 9 })), 'gray')
  })

  it('seals tokens so only the key opens them', async () => {
    const sealed = await withEnv({ BEEMINDER_TOKEN_KEY: KEY }, () => {
      const sealed = sealToken(TOKEN)
      assert.ok(!sealed.includes(TOKEN))
      assert.notStrictEqual(sealToken(TOKEN), sealed)
      assert.strictEqual(openToken(sealed), TOKEN)
      return sealed
    })
    await withEnv({ BEEMINDER_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64') }, () => {
      assert.strictEqual(openToken(sealed), undefined)
    })
  })
})

describe('beeminder properties', () => {
  const day = 86_400_000
  const now = fc.integer({ min: NOW - 365 * day, max: NOW + 365 * day })

  it('round-trips tokens, and rejects them under another key', async () => {
    await withEnv({ BEEMINDER_TOKEN_KEY: KEY }, () => fc.assert(fc.property(fc.string({ minLength: 1 }), t => {
      const sealed = sealToken(t)
      assert.strictEqual(openToken(sealed), t)
      assert.strictEqual(withEnvSync({ BEEMINDER_TOKEN_KEY: 'other' }, () => openToken(sealed)), undefined)
    })))
  })

  it('halves zeno gaps down to the floor', () => {
    fc.assert(fc.property(now, fc.integer({ min: 1, max: 48 }), fc.integer({ min: 1, max: 60 }), (lose, startH, floorM) => {
      const times = zenoTimes(lose, startH * HOUR_MS, floorM * MINUTE_MS)
      const before = times.map(t => lose - t)
      before.forEach((b, i) => { if (i) assert.strictEqual(b, before[i - 1]! / 2) })
      assert.ok(before.every(b => b >= floorM * MINUTE_MS))
    }))
  })

  it('polls within a minute and the cap', () => {
    const color = fc.constantFrom('red', 'orange', 'blue', 'green', 'gray')
    const goals = fc.array(fc.record({ dl: fc.integer({ min: -2 * day, max: 10 * day }), color, won: fc.boolean() }), { maxLength: 4 })
    fc.assert(fc.property(goals, now, zone, fc.integer({ min: 1, max: 48 }), (gs, t, tz, maxH) => {
      const list = gs.map((g, i) => goal(`g${i}`, { losedate: (t + g.dl) / 1000, roadstatuscolor: g.color, won: g.won }))
      const next = nextPollAt(list, t, tz, { maxMs: maxH * HOUR_MS })
      assert.ok(next >= t + MINUTE_MS && next <= t + maxH * HOUR_MS)
    }))
  })

  it('ends quiet hours after now, outside quiet hours', () => {
    const quiet = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 23 })).filter(([a, b]) => a !== b).map(([start, end]) => ({ start, end }))
    fc.assert(fc.property(now, zone, quiet, (t, tz, q) => {
      const end = quietEnd(t, tz, q)
      assert.ok(end > t && end <= t + 25 * HOUR_MS)
      assert.strictEqual(isQuiet(end, tz, q), false)
      assert.deepStrictEqual(parseQuiet(`${q.start}-${q.end}`), q)
    }))
  })
})

describe('Beeminder', () => {
  const state = setupRobot('Beeminder.ts', { envVars: ENV })
  let fake: Fake
  let sent: { room: string, text: string }[]
  let ada: User
  let now: ReturnType<typeof clock>

  beforeEach(() => {
    process.env.BEEMINDER_TOKEN_KEY = KEY
    delete process.env.BEEMINDER_MAX_POLL_HOURS
    delete process.env.BEEMINDER_ZENO_START_HOURS
    delete process.env.BEEMINDER_QUIET_HOURS
    now = clock(NOW)
    // lines in list order
    setRandomSource(() => 0)
    fake = fakeBeeminder()
    sent = collectRooms(state.robot)
    ada = brainUser(state.robot, '1001', 'ada')
  })

  const link = async () => {
    dm(ada)
    await say(state.robot, ada, `bee link ${TOKEN}`, 'dm-ada')
    sent.length = 0
  }

  const setNow = (ms: number) => now.set(ms)

  describe('linking', () => {
    it('stores the token encrypted from a dm', async () => {
      const { robot } = state
      dm(ada)
      await say(robot, ada, `bee link ${TOKEN}`, 'dm-ada')
      assert.match(sent[0]!.text, /Linked as \*\*ada\*\*/)
      const stored = robot.brain.get<string>('bee:token:1001')!
      assert.ok(!stored.includes(TOKEN))
      assert.strictEqual(openToken(stored), TOKEN)
      assert.strictEqual(robot.brain.get('bee:user:1001'), 'ada')
      assert.ok(!sent[0]!.text.includes(TOKEN))
    })

    it('refuses and tries to delete a token posted in a channel', async () => {
      const { robot } = state
      let deleted = false
      channel(ada, { delete: async () => { deleted = true } })
      await say(robot, ada, `bee link ${TOKEN}`, 'general')
      assert.ok(deleted)
      assert.match(sent[0]!.text, /Never post your Beeminder token in a channel/)
      assert.strictEqual(robot.brain.get('bee:token:1001'), null)
      assert.strictEqual(fake.calls.length, 0)
    })

    it('says linking is off without a key', async () => {
      delete process.env.BEEMINDER_TOKEN_KEY
      dm(ada)
      await say(state.robot, ada, `bee link ${TOKEN}`, 'dm-ada')
      assert.match(sent[0]!.text, /linking is off/)
    })

    it('rejects a token beeminder refuses', async () => {
      dm(ada)
      await say(state.robot, ada, 'bee link wrongtoken123', 'dm-ada')
      assert.match(sent[0]!.text, /didn't accept that token/)
      assert.strictEqual(state.robot.brain.get('bee:token:1001'), null)
    })

    it('moves an account to whoever links it last', async () => {
      const { robot } = state
      await link()
      const bob = brainUser(robot, '1002', 'bob')
      dm(bob)
      await say(robot, bob, `bee link ${TOKEN}`, 'dm-bob')
      assert.strictEqual(robot.brain.get('bee:user:1001'), null)
      assert.strictEqual(robot.brain.get('bee:user:1002'), 'ada')
    })

    it('unlinks everything', async () => {
      const { robot } = state
      await link()
      fake.goals = [goal('pushups')]
      channel(ada)
      await say(robot, ada, 'bee subscribe', 'general')
      await say(robot, ada, 'bee unlink', 'general')
      assert.match(sent.at(-1)!.text, /Unlinked ada/)
      assert.strictEqual(robot.brain.get('bee:token:1001'), null)
      assert.deepStrictEqual(robot.brain.get('bee:subs'), {})
      assert.strictEqual(jobs(robot).length, 0)
    })
  })

  describe('goals', () => {
    beforeEach(() => {
      fake.goals = [
        goal('reading', { losedate: TONIGHT / 1000 + 5 * 86_400, safebuf: 5 }),
        redGoal('pushups', { rate: 20.291666666666668, runits: 'd' }),
        goal('diary', { secret: true, roadstatuscolor: 'orange', safebuf: 1, losedate: TONIGHT / 1000 + 86_400 }),
        goal('done', { won: true })
      ]
    })

    it('lists goals most urgent first and hides secret ones in channels', async () => {
      await link()
      channel(ada)
      await say(state.robot, ada, 'bee', 'general')
      assert.strictEqual(sent[0]!.text, [
        '🐝 Your goals:',
        '🔴 **pushups**: +3 pushups by today at 11:59pm',
        '🟢 **reading**: +1 pushup by Sun, Nov 22 at 11:59pm'
      ].join('\n'))
    })

    it('shows secret goals in a dm', async () => {
      await link()
      await say(state.robot, ada, 'beeminder goals', 'dm-ada')
      assert.match(sent[0]!.text, /🟠 \*\*diary\*\*/)
    })

    it('filters by color', async () => {
      await link()
      channel(ada)
      await say(state.robot, ada, 'bee goals red', 'general')
      assert.strictEqual(sent[0]!.text, '🐝 Your red goals:\n🔴 **pushups**: +3 pushups by today at 11:59pm')
      await say(state.robot, ada, 'bee blue', 'general')
      assert.strictEqual(sent[1]!.text, '🐝 No blue goals.')
    })

    it('shows someone else\'s public goals', async () => {
      const { robot } = state
      await link()
      const bob = brainUser(robot, '1002', 'bob')
      channel(bob)
      await say(robot, bob, 'bee goals for <@1001>', 'general')
      assert.match(sent[0]!.text, /^🐝 \*\*ada\*\*'s goals:/)
      assert.ok(!sent[0]!.text.includes('diary'))
    })

    it('points people without a link at bee link', async () => {
      channel(ada)
      await say(state.robot, ada, 'bee', 'general')
      assert.match(sent[0]!.text, /haven't linked Beeminder/)
    })

    it('shows one goal', async () => {
      await link()
      channel(ada)
      await say(state.robot, ada, 'bee pushups', 'general')
      assert.strictEqual(sent[0]!.text, [
        '🐝 🔴 **pushups**',
        '+3 pushups by today at 11:59pm, 11h 59m left · 0 days safe · rate 20.29 pushups/d',
        '<https://www.beeminder.com/ada/pushups>'
      ].join('\n'))
      await say(state.robot, ada, 'bee diary', 'general')
      assert.match(sent[1]!.text, /it's secret/)
    })
  })

  describe('alerts', () => {
    const subscribe = async (text = 'bee subscribe') => {
      await link()
      channel(ada)
      await say(state.robot, ada, text, 'general')
      // the seed poll
      await tick(30)
      sent.length = 0
    }

    it('subscribes, seeds silently and schedules the next poll', async () => {
      const { robot } = state
      fake.goals = [goal('reading'), redGoal('pushups')]
      await link()
      channel(ada)
      await say(robot, ada, 'bee subscribe', 'general')
      await tick(30)
      assert.match(sent[0]!.text, /Alerts for all your public goals will buzz here/)
      assert.strictEqual(sent.length, 1)
      assert.deepStrictEqual(Object.keys(robot.brain.get<Record<string, unknown>>('bee:snap:1001')!).sort(), ['pushups', 'reading'])
      // the 2h cap comes before the first zeno alert
      assert.strictEqual(jobs(robot)[0]!.at, NOW + 2 * HOUR_MS)
      await say(robot, ada, 'bee subscriptions', 'general')
      assert.strictEqual(sent.at(-1)!.text, '🐝 Beeminder alerts here:\n<@1001> (ada): all goals')
    })

    it('only follows the listed goals, and refuses secret ones in a channel', async () => {
      const { robot } = state
      fake.goals = [goal('reading'), goal('diary', { secret: true })]
      await link()
      channel(ada)
      await say(robot, ada, 'bee subscribe diary', 'general')
      assert.match(sent[0]!.text, /can't find diary among your public goals/)
      await say(robot, ada, 'bee subscribe reading', 'general')
      assert.match(sent[1]!.text, /Alerts for \*reading\*/)
      await say(robot, ada, 'bee unsubscribe reading', 'general')
      assert.match(sent[2]!.text, /No more Beeminder alerts/)
      assert.strictEqual(jobs(robot).length, 0)
    })

    it('alerts when a goal turns red', async () => {
      const { robot } = state
      fake.goals = [goal('pushups', { losedate: TONIGHT / 1000, safebuf: 1, roadstatuscolor: 'orange' })]
      await subscribe()
      fake.goals = [redGoal('pushups')]
      await pollNow(robot)
      assert.deepStrictEqual(sent, [{ room: 'general', text: '🐝 <@1001>, *pushups* is a beemergency: +3 pushups by today at 11:59pm.' }])
    })

    it('counts down with zeno alerts, once per step, collapsing missed ones', async () => {
      const { robot } = state
      fake.goals = [redGoal('pushups')]
      await subscribe()
      setNow(TONIGHT - 8 * HOUR_MS)
      await pollNow(robot)
      assert.strictEqual(sent.length, 1)
      // pings the member
      assert.ok(sent[0]!.text.includes('<@1001>'))
      assert.match(sent[0]!.text, /derails in 8h/)
      assert.strictEqual(jobs(robot)[0]!.at, TONIGHT - 6 * HOUR_MS)
      setNow(TONIGHT - 2 * HOUR_MS)
      await pollNow(robot)
      assert.strictEqual(jobs(robot)[0]!.at, TONIGHT - HOUR_MS)
      sent.length = 1
      // same step again: quiet
      await pollNow(robot)
      assert.strictEqual(sent.length, 1)
      // missed 4h, 2h and 1h: one alert
      setNow(TONIGHT - 50 * MINUTE_MS)
      await pollNow(robot)
      assert.strictEqual(sent.length, 2)
      assert.match(sent[1]!.text, /50m/)
      setNow(TONIGHT - 10 * MINUTE_MS)
      await pollNow(robot)
      assert.match(sent[2]!.text, /^🐝 🚨/)
    })

    it('alerts when a midnight goal turns red around midnight', async () => {
      const { robot } = state
      const tomorrow = TONIGHT / 1000 + 86_400
      fake.goals = [goal('pushups', { losedate: tomorrow, safebuf: 1, roadstatuscolor: 'orange' })]
      await subscribe()
      setNow(TONIGHT + 2 * MINUTE_MS)
      fake.goals = [redGoal('pushups', { losedate: tomorrow })]
      await pollNow(robot)
      assert.deepStrictEqual(sent.map(s => s.text), ['🐝 <@1001>, *pushups* is a beemergency: +3 pushups by today at 11:59pm.'])
    })

    it('holds a goal that turns red overnight until morning', async () => {
      const { robot } = state
      const tomorrow = TONIGHT / 1000 + 86_400
      fake.goals = [goal('pushups', { losedate: tomorrow, safebuf: 1, roadstatuscolor: 'orange' })]
      await subscribe()
      setNow(TONIGHT + 2 * HOUR_MS)
      fake.goals = [redGoal('pushups', { losedate: tomorrow })]
      await pollNow(robot)
      assert.strictEqual(sent.length, 0)
      const eight = Date.parse('2026-11-18T08:00:00Z')
      assert.ok(jobs(robot)[0]!.at <= eight)
      // still quiet at 6am
      setNow(eight - 2 * HOUR_MS)
      await pollNow(robot)
      assert.strictEqual(sent.length, 0)
      assert.strictEqual(jobs(robot)[0]!.at, eight)
      setNow(eight)
      await pollNow(robot)
      assert.deepStrictEqual(sent.map(s => s.text), ['🐝 <@1001>, *pushups* is a beemergency: +3 pushups by today at 11:59pm.'])
    })

    it('still alerts overnight when the deadline is close, like a 3am goal', async () => {
      const { robot } = state
      const three = Date.parse('2026-11-18T02:59:00Z')
      fake.goals = [goal('sleep', { losedate: three / 1000, safebuf: 1, roadstatuscolor: 'orange' })]
      await subscribe()
      setNow(Date.parse('2026-11-18T00:30:00Z'))
      fake.goals = [redGoal('sleep', { losedate: three / 1000 })]
      await pollNow(robot)
      assert.strictEqual(sent.length, 1)
      assert.match(sent[0]!.text, /\*sleep\* is a beemergency/)
      assert.strictEqual(jobs(robot)[0]!.at, three - 2 * HOUR_MS)
      setNow(three - 2 * HOUR_MS)
      await pollNow(robot)
      assert.match(sent[1]!.text, /2h/)
    })

    it('sends red alerts overnight with quiet hours off', async () => {
      const { robot } = state
      process.env.BEEMINDER_QUIET_HOURS = 'off'
      const tomorrow = TONIGHT / 1000 + 86_400
      fake.goals = [goal('pushups', { losedate: tomorrow, safebuf: 1, roadstatuscolor: 'orange' })]
      await subscribe()
      setNow(TONIGHT + 2 * HOUR_MS)
      fake.goals = [redGoal('pushups', { losedate: tomorrow })]
      await pollNow(robot)
      assert.strictEqual(sent.length, 1)
    })

    it('cheers a rescue and stops the countdown', async () => {
      const { robot } = state
      fake.goals = [redGoal('pushups')]
      await subscribe()
      setNow(TONIGHT - 3 * HOUR_MS)
      fake.goals = [goal('pushups', { losedate: TONIGHT / 1000 + 2 * 86_400, safebuf: 2, roadstatuscolor: 'blue' })]
      await pollNow(robot)
      assert.deepStrictEqual(sent.map(s => s.text), ['🐝 <@1001> rescued *pushups*: safe for 2 days. 🎉'])
      await pollNow(robot)
      assert.strictEqual(sent.length, 1)
    })

    it('waits for the derail datapoint, then announces the derail once', async () => {
      const { robot } = state
      fake.goals = [redGoal('pushups', { lasttouch: '2026-11-16T20:00:00Z' })]
      await subscribe()
      // just past the deadline, respite may show
      setNow(TONIGHT + 2 * MINUTE_MS)
      fake.goals = [goal('pushups', { losedate: TONIGHT / 1000 + 8 * 86_400, safebuf: 7, lasttouch: '2026-11-16T20:00:00Z' })]
      await pollNow(robot)
      assert.strictEqual(sent.length, 0)
      assert.strictEqual(jobs(robot)[0]!.at, TONIGHT + 32 * MINUTE_MS)
      // beeminder's derail datapoint, about 7h later
      setNow(TONIGHT + 7 * HOUR_MS + 10 * MINUTE_MS)
      fake.datapoints = [{ timestamp: TONIGHT / 1000 + 7 * 3600, value: 0, comment: '#DERAIL ON THE 17th', created_at: new Date(TONIGHT + 7 * HOUR_MS + 5 * MINUTE_MS).toISOString() }]
      await pollNow(robot)
      // quiet hours: waits for 8am
      assert.strictEqual(sent.length, 0)
      const eight = Date.parse('2026-11-18T08:00:00Z')
      // rechecks in 30m, then the morning
      assert.strictEqual(jobs(robot)[0]!.at, TONIGHT + 7 * HOUR_MS + 40 * MINUTE_MS)
      setNow(TONIGHT + 7 * HOUR_MS + 40 * MINUTE_MS)
      await pollNow(robot)
      assert.strictEqual(sent.length, 0)
      assert.strictEqual(jobs(robot)[0]!.at, eight)
      setNow(eight)
      await pollNow(robot)
      assert.deepStrictEqual(sent.map(s => s.text), ['🐝 💥 <@1001> derailed on *pushups*. Dust off and go again.'])
      await pollNow(robot)
      assert.strictEqual(sent.length, 1)
    })

    it('ignores an old derail datapoint', async () => {
      const { robot } = state
      fake.goals = [redGoal('pushups')]
      await subscribe()
      setNow(TONIGHT + 2 * MINUTE_MS)
      fake.datapoints = [{ timestamp: 0, value: 0, comment: '#DERAIL ON THE 14th', created_at: '2026-09-15T07:06:00Z' }]
      await pollNow(robot)
      assert.strictEqual(sent.length, 0)
      // gives up after a day
      setNow(TONIGHT + 25 * HOUR_MS)
      await pollNow(robot)
      assert.strictEqual(sent.length, 0)
      assert.strictEqual(robot.brain.get<Record<string, { derailFor?: number }>>('bee:snap:1001')!.pushups!.derailFor, undefined)
    })

    it('treats data just before the deadline as a rescue, not a derail', async () => {
      const { robot } = state
      fake.goals = [redGoal('pushups')]
      await subscribe()
      setNow(TONIGHT + 2 * MINUTE_MS)
      fake.goals = [goal('pushups', { losedate: TONIGHT / 1000 + 86_400, safebuf: 1, roadstatuscolor: 'orange', lasttouch: new Date(TONIGHT - 5 * MINUTE_MS).toISOString() })]
      await pollNow(robot)
      assert.deepStrictEqual(sent.map(s => s.text), ['🐝 <@1001> rescued *pushups*: safe for 1 day. 🎉'])
      assert.strictEqual(fake.calls.filter(c => c.includes('datapoints')).length, 0)
    })

    it('unlinks and tells the owner in a dm when the token stops working', async () => {
      const { robot } = state
      fake.goals = [goal('pushups')]
      await subscribe()
      fake.status = 401
      await pollNow(robot)
      assert.deepStrictEqual(sent, [{ room: 'dm-ada', text: '🐝 Beeminder stopped accepting your token, so I unlinked you. DM me `bee link <token>` with a fresh one to start again.' }])
      assert.strictEqual(robot.brain.get('bee:token:1001'), null)
      assert.strictEqual(jobs(robot).length, 0)
    })

    it('retries in 5 minutes when beeminder errors', async () => {
      const { robot } = state
      fake.goals = [goal('pushups')]
      await subscribe()
      fake.status = 503
      await pollNow(robot)
      assert.strictEqual(jobs(robot)[0]!.at, NOW + 5 * MINUTE_MS)
      assert.strictEqual(sent.length, 0)
    })

    it('waits for the cap when everything is safe', async () => {
      const { robot } = state
      process.env.BEEMINDER_MAX_POLL_HOURS = '3'
      fake.goals = [goal('pushups')]
      await subscribe()
      assert.strictEqual(jobs(robot)[0]!.at, NOW + 3 * HOUR_MS)
    })
  })
})
