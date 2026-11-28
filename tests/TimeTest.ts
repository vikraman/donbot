import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { canonicalTz, dayKey, weekKey, describeRepeat, formatClock, formatWhen, fromZoned, nextOccurrence, parseClock, parseDays, zonedParts, DAY_MS, MAX_AHEAD_MS, MIN_INTERVAL_MS, MINUTE_MS } from '../scripts/lib/time.ts'
import { parseWhen } from '../scripts/lib/when.ts'
import type { Repeat } from '../scripts/lib/time.ts'
import { fc, hour, instant, minute, weekdays, zone } from './helpers/arb.ts'

// mon 2026-11-16 10:00 utc
const NOW = Date.UTC(2026, 10, 16, 10, 0)

describe('time helpers', () => {
  it('canonicalizes timezone names', () => {
    assert.strictEqual(canonicalTz('europe/london'), 'Europe/London')
    assert.strictEqual(canonicalTz('Not/AZone'), undefined)
    assert.strictEqual(canonicalTz('asia/kolkata'), 'Asia/Kolkata')
    assert.strictEqual(canonicalTz('utc'), 'UTC')
  })
  it('round-trips wall-clock time across zones', () => {
    const ms = fromZoned(2026, 11, 16, 9, 30, 'America/New_York')
    assert.strictEqual(ms, Date.UTC(2026, 10, 16, 14, 30))
    const p = zonedParts(ms, 'America/New_York')
    assert.deepStrictEqual([p.hour, p.minute, p.weekday], [9, 30, 1])
  })
  it('handles dst in fromZoned', () => {
    // london summer time
    assert.strictEqual(fromZoned(2026, 7, 1, 9, 0, 'Europe/London'), Date.UTC(2026, 6, 1, 8, 0))
  })
  it('parses clocks', () => {
    assert.deepStrictEqual(parseClock('3pm'), { hour: 15, minute: 0 })
    assert.deepStrictEqual(parseClock('12am'), { hour: 0, minute: 0 })
    assert.deepStrictEqual(parseClock('9:05 am'), { hour: 9, minute: 5 })
    assert.deepStrictEqual(parseClock('17:45'), { hour: 17, minute: 45 })
    assert.deepStrictEqual(parseClock('noon'), { hour: 12, minute: 0 })
    assert.strictEqual(parseClock('25:00'), undefined)
    assert.strictEqual(parseClock('13pm'), undefined)
  })
  it('parses day lists', () => {
    assert.deepStrictEqual(parseDays('weekday'), [1, 2, 3, 4, 5])
    assert.deepStrictEqual(parseDays('mon, wed and fri'), [1, 3, 5])
    assert.deepStrictEqual(parseDays('fridays'), [5])
    assert.strictEqual(parseDays('someday'), undefined)
  })
  it('parses relative times', () => {
    assert.deepStrictEqual(parseWhen('in 5 minutes', 'UTC', NOW), { at: NOW + 5 * 60_000 })
    assert.deepStrictEqual(parseWhen('in an hour', 'UTC', NOW), { at: NOW + 3_600_000 })
    assert.deepStrictEqual(parseWhen('in 2 days', 'UTC', NOW), { at: NOW + 2 * 86_400_000 })
    assert.strictEqual(parseWhen('in 5 eons', 'UTC', NOW), undefined)
  })
  it('parses clock times in the given zone', () => {
    assert.strictEqual(parseWhen('at 3pm', 'UTC', NOW)!.at, Date.UTC(2026, 10, 16, 15, 0))
    // already past today -> tomorrow
    assert.strictEqual(parseWhen('at 9am', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 9, 0))
    assert.strictEqual(parseWhen('3pm', 'America/New_York', NOW)!.at, Date.UTC(2026, 10, 16, 20, 0))
    assert.strictEqual(parseWhen('tomorrow at 8:30am', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 8, 30))
    assert.strictEqual(parseWhen('at noon tomorrow', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 12, 0))
    assert.strictEqual(parseWhen('tomorrow', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 9, 0))
    assert.strictEqual(parseWhen('on friday at 10:30', 'UTC', NOW)!.at, Date.UTC(2026, 10, 20, 10, 30))
    assert.strictEqual(parseWhen('friday at 5pm', 'UTC', NOW)!.at, Date.UTC(2026, 10, 20, 17, 0))
    // bare 1-7 means pm
    assert.strictEqual(parseWhen('at 3', 'UTC', NOW)!.at, Date.UTC(2026, 10, 16, 15, 0))
    assert.strictEqual(parseWhen('friday at 3', 'UTC', NOW)!.at, Date.UTC(2026, 10, 20, 15, 0))
    assert.strictEqual(parseWhen('at 3am', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 3, 0))
    assert.strictEqual(parseWhen('at 9', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 9, 0))
    assert.strictEqual(parseWhen('tonight at 8', 'UTC', NOW)!.at, Date.UTC(2026, 10, 16, 20, 0))
    assert.strictEqual(parseWhen('at 11 tonight', 'UTC', NOW)!.at, Date.UTC(2026, 10, 16, 23, 0))
    assert.deepStrictEqual(parseWhen('every weekday at 4', 'UTC', NOW)!.repeat, { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 16, minute: 0 })
    assert.strictEqual(parseWhen('3', 'UTC', NOW), undefined)
  })
  it('parses recurring schedules', () => {
    const daily = parseWhen('every weekday at 9am', 'UTC', NOW)!
    assert.deepStrictEqual(daily.repeat, { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
    assert.strictEqual(daily.at, Date.UTC(2026, 10, 17, 9, 0))
    const fri = parseWhen('every friday at 4pm', 'UTC', NOW)!
    assert.strictEqual(fri.at, Date.UTC(2026, 10, 20, 16, 0))
    const hourly = parseWhen('every 2 hours', 'UTC', NOW)!
    assert.deepStrictEqual(hourly, { at: NOW + 7_200_000, repeat: { kind: 'interval', everyMs: 7_200_000 } })
    assert.strictEqual(parseWhen('every 10 seconds', 'UTC', NOW), undefined)
  })
  it('skips weekends for weekday repeats', () => {
    const repeat = { kind: 'weekly' as const, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
    // fri 9am -> mon 9am
    assert.strictEqual(nextOccurrence(repeat, 'UTC', Date.UTC(2026, 10, 20, 9, 0)), Date.UTC(2026, 10, 23, 9, 0))
  })
  it('describes repeats and times', () => {
    assert.strictEqual(describeRepeat({ kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }), 'every weekday at 9am')
    assert.strictEqual(describeRepeat({ kind: 'weekly', days: [1, 3], hour: 14, minute: 30 }), 'every Monday, Wednesday at 2:30pm')
    assert.strictEqual(describeRepeat({ kind: 'interval', everyMs: 7_200_000 }), 'every 2 hours')
    assert.strictEqual(formatWhen(Date.UTC(2026, 10, 16, 15, 0), 'UTC', NOW), 'today at 3pm')
    assert.strictEqual(formatWhen(Date.UTC(2026, 10, 17, 9, 0), 'UTC', NOW), 'tomorrow at 9am')
    assert.strictEqual(formatWhen(Date.UTC(2026, 10, 20, 9, 0), 'UTC', NOW), 'Fri, Nov 20 at 9am')
  })
  it('keys days in the given zone', () => {
    // 03:00 utc is still the 15th in la
    assert.strictEqual(dayKey(Date.UTC(2026, 10, 16, 3, 0), 'America/Los_Angeles'), '2026-11-15')
    assert.strictEqual(dayKey(Date.UTC(2026, 10, 16, 3, 0), 'UTC'), '2026-11-16')
  })
  it('keys weeks by their monday', () => {
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 16, 10, 0), 'UTC'), '2026-11-16')
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 22, 23, 0), 'UTC'), '2026-11-16')
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 23, 0, 30), 'UTC'), '2026-11-23')
    // still sunday in la
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 23, 3, 0), 'America/Los_Angeles'), '2026-11-16')
  })
  it('rejects times absurdly far ahead', () => {
    assert.strictEqual(parseWhen('in 99999999999 weeks', 'UTC', NOW), undefined)
    assert.strictEqual(parseWhen('in 3 years', 'UTC', NOW), undefined)
    assert.strictEqual(parseWhen('every 900 days', 'UTC', NOW), undefined)
    assert.ok(parseWhen('in 52 weeks', 'UTC', NOW))
  })
})

describe('time properties', () => {
  it('round-trips wall-clock parts through fromZoned', () => {
    fc.assert(fc.property(instant, zone, (ms, tz) => {
      const p = zonedParts(ms, tz)
      assert.deepStrictEqual(zonedParts(fromZoned(p.year, p.month, p.day, p.hour, p.minute, tz), tz), p)
    }))
  })

  it('round-trips clocks through formatClock', () => {
    fc.assert(fc.property(hour, minute, (h, m) => {
      assert.deepStrictEqual(parseClock(formatClock(h, m)), { hour: h, minute: m })
    }))
  })

  it('keys weeks by a monday no later than the day', () => {
    fc.assert(fc.property(instant, zone, (ms, tz) => {
      const week = weekKey(ms, tz)
      assert.ok(week <= dayKey(ms, tz))
      assert.strictEqual(new Date(`${week}T12:00Z`).getUTCDay(), 1)
    }))
  })

  it('finds the next weekly occurrence within a week, on an allowed day', () => {
    fc.assert(fc.property(weekdays, hour, minute, zone, instant, (days, h, m, tz, after) => {
      const next = nextOccurrence({ kind: 'weekly', days, hour: h, minute: m }, tz, after)
      assert.ok(next > after && next <= after + 8 * DAY_MS)
      assert.ok(days.includes(zonedParts(next, tz).weekday))
    }))
  })

  it('parses described repeats back', () => {
    const weekly = fc.record({ kind: fc.constant('weekly' as const), days: weekdays, hour, minute }).map(r => ({ ...r }))
    // every day and every week mean daily and weekly at 9am
    const interval = fc.integer({ min: MIN_INTERVAL_MS / MINUTE_MS, max: 60 * 24 * 30 })
      .map(n => n * MINUTE_MS)
      .filter(ms => ms !== DAY_MS && ms !== 7 * DAY_MS)
      .map(everyMs => ({ kind: 'interval' as const, everyMs }))
    const monthly = fc.record({ kind: fc.constant('monthly' as const), day: fc.integer({ min: 1, max: 31 }), hour, minute }).map(r => ({ ...r }))
    fc.assert(fc.property(fc.oneof(weekly, interval, monthly), zone, (repeat: Repeat, tz) => {
      assert.deepStrictEqual(parseWhen(describeRepeat(repeat), tz, NOW)?.repeat, repeat)
    }))
  })

  it('never schedules past MAX_AHEAD_MS', () => {
    const unit = fc.constantFrom('seconds', 'minutes', 'hours', 'days', 'weeks')
    fc.assert(fc.property(fc.nat({ max: 2_000_000 }), unit, zone, (n, u, tz) => {
      const when = parseWhen(`in ${n} ${u}`, tz, NOW)
      if (when) assert.ok(when.at > NOW && when.at - NOW <= MAX_AHEAD_MS)
    }))
  })
})
