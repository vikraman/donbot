import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { canonicalTz, dayKey, weekKey, describeRepeat, formatWhen, fromZoned, nextOccurrence, parseClock, parseDays, parseWhen, zonedParts } from '../scripts/lib/time.ts'

// mon 2026-11-16 10:00 utc
const NOW = Date.UTC(2026, 10, 16, 10, 0)

describe('time helpers', () => {
  it('canonicalizes timezone names', () => {
    assert.equal(canonicalTz('europe/london'), 'Europe/London')
    assert.equal(canonicalTz('Not/AZone'), undefined)
    assert.equal(canonicalTz('asia/kolkata'), 'Asia/Kolkata')
    assert.equal(canonicalTz('utc'), 'UTC')
  })
  it('round-trips wall-clock time across zones', () => {
    const ms = fromZoned(2026, 11, 16, 9, 30, 'America/New_York')
    assert.equal(ms, Date.UTC(2026, 10, 16, 14, 30))
    const p = zonedParts(ms, 'America/New_York')
    assert.deepEqual([p.hour, p.minute, p.weekday], [9, 30, 1])
  })
  it('handles dst in fromZoned', () => {
    // london summer time
    assert.equal(fromZoned(2026, 7, 1, 9, 0, 'Europe/London'), Date.UTC(2026, 6, 1, 8, 0))
  })
  it('parses clocks', () => {
    assert.deepEqual(parseClock('3pm'), { hour: 15, minute: 0 })
    assert.deepEqual(parseClock('12am'), { hour: 0, minute: 0 })
    assert.deepEqual(parseClock('9:05 am'), { hour: 9, minute: 5 })
    assert.deepEqual(parseClock('17:45'), { hour: 17, minute: 45 })
    assert.deepEqual(parseClock('noon'), { hour: 12, minute: 0 })
    assert.equal(parseClock('25:00'), undefined)
    assert.equal(parseClock('13pm'), undefined)
  })
  it('parses day lists', () => {
    assert.deepEqual(parseDays('weekday'), [1, 2, 3, 4, 5])
    assert.deepEqual(parseDays('mon, wed and fri'), [1, 3, 5])
    assert.deepEqual(parseDays('fridays'), [5])
    assert.equal(parseDays('someday'), undefined)
  })
  it('parses relative times', () => {
    assert.deepEqual(parseWhen('in 5 minutes', 'UTC', NOW), { at: NOW + 5 * 60_000 })
    assert.deepEqual(parseWhen('in an hour', 'UTC', NOW), { at: NOW + 3_600_000 })
    assert.deepEqual(parseWhen('in 2 days', 'UTC', NOW), { at: NOW + 2 * 86_400_000 })
    assert.equal(parseWhen('in 5 fortnights', 'UTC', NOW), undefined)
  })
  it('parses clock times in the given zone', () => {
    assert.equal(parseWhen('at 3pm', 'UTC', NOW)!.at, Date.UTC(2026, 10, 16, 15, 0))
    // already past today -> tomorrow
    assert.equal(parseWhen('at 9am', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 9, 0))
    assert.equal(parseWhen('3pm', 'America/New_York', NOW)!.at, Date.UTC(2026, 10, 16, 20, 0))
    assert.equal(parseWhen('tomorrow at 8:30am', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 8, 30))
    assert.equal(parseWhen('at noon tomorrow', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 12, 0))
    assert.equal(parseWhen('tomorrow', 'UTC', NOW)!.at, Date.UTC(2026, 10, 17, 9, 0))
    assert.equal(parseWhen('on friday at 10:30', 'UTC', NOW)!.at, Date.UTC(2026, 10, 20, 10, 30))
    assert.equal(parseWhen('friday at 5pm', 'UTC', NOW)!.at, Date.UTC(2026, 10, 20, 17, 0))
    assert.equal(parseWhen('at 3', 'UTC', NOW)!.at, Date.UTC(2026, 10, 16, 15, 0) - 12 * 3_600_000 + 86_400_000)
    assert.equal(parseWhen('3', 'UTC', NOW), undefined)
  })
  it('parses recurring schedules', () => {
    const daily = parseWhen('every weekday at 9am', 'UTC', NOW)!
    assert.deepEqual(daily.repeat, { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
    assert.equal(daily.at, Date.UTC(2026, 10, 17, 9, 0))
    const fri = parseWhen('every friday at 4pm', 'UTC', NOW)!
    assert.equal(fri.at, Date.UTC(2026, 10, 20, 16, 0))
    const hourly = parseWhen('every 2 hours', 'UTC', NOW)!
    assert.deepEqual(hourly, { at: NOW + 7_200_000, repeat: { kind: 'interval', everyMs: 7_200_000 } })
    assert.equal(parseWhen('every 10 seconds', 'UTC', NOW), undefined)
  })
  it('skips weekends for weekday repeats', () => {
    const repeat = { kind: 'weekly' as const, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
    // fri 9am -> mon 9am
    assert.equal(nextOccurrence(repeat, 'UTC', Date.UTC(2026, 10, 20, 9, 0)), Date.UTC(2026, 10, 23, 9, 0))
  })
  it('describes repeats and times', () => {
    assert.equal(describeRepeat({ kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }), 'every weekday at 9am')
    assert.equal(describeRepeat({ kind: 'weekly', days: [1, 3], hour: 14, minute: 30 }), 'every Monday, Wednesday at 2:30pm')
    assert.equal(describeRepeat({ kind: 'interval', everyMs: 7_200_000 }), 'every 2 hours')
    assert.equal(formatWhen(Date.UTC(2026, 10, 16, 15, 0), 'UTC', NOW), 'today at 3pm')
    assert.equal(formatWhen(Date.UTC(2026, 10, 17, 9, 0), 'UTC', NOW), 'tomorrow at 9am')
    assert.equal(formatWhen(Date.UTC(2026, 10, 20, 9, 0), 'UTC', NOW), 'Fri, Nov 20 at 9am')
  })
  it('keys days in the given zone', () => {
    // 03:00 utc is still the 15th in la
    assert.equal(dayKey(Date.UTC(2026, 10, 16, 3, 0), 'America/Los_Angeles'), '2026-11-15')
    assert.equal(dayKey(Date.UTC(2026, 10, 16, 3, 0), 'UTC'), '2026-11-16')
  })
  it('keys weeks by their monday', () => {
    assert.equal(weekKey(Date.UTC(2026, 10, 16, 10, 0), 'UTC'), '2026-11-16')
    assert.equal(weekKey(Date.UTC(2026, 10, 22, 23, 0), 'UTC'), '2026-11-16')
    assert.equal(weekKey(Date.UTC(2026, 10, 23, 0, 30), 'UTC'), '2026-11-23')
    // still sunday in la
    assert.equal(weekKey(Date.UTC(2026, 10, 23, 3, 0), 'America/Los_Angeles'), '2026-11-16')
  })
})
