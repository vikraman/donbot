import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { findWhen, parseDuration, parseWhen } from '../scripts/lib/when.ts'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../scripts/lib/time.ts'

// mon 2026-11-16 10:00 utc
const NOW = Date.UTC(2026, 10, 16, 10, 0)
const at = (text: string): number | undefined => parseWhen(text, 'UTC', NOW)?.at
const utc = (day: number, hour: number, minute = 0, month = 11): number => Date.UTC(2026, month - 1, day, hour, minute)

describe('parseWhen', () => {
  it('reads relative times', () => {
    assert.strictEqual(at('in half an hour'), NOW + 30 * MINUTE_MS)
    assert.strictEqual(at('in 1.5 hours'), NOW + 90 * MINUTE_MS)
    assert.strictEqual(at('in 1h30m'), NOW + 90 * MINUTE_MS)
    assert.strictEqual(at('in an hour and a half'), NOW + 90 * MINUTE_MS)
    assert.strictEqual(at('in 2 hours and 15 minutes'), NOW + 135 * MINUTE_MS)
    assert.strictEqual(at('in a couple of hours'), NOW + 2 * HOUR_MS)
    assert.strictEqual(at('20 minutes from now'), NOW + 20 * MINUTE_MS)
    assert.strictEqual(at('in 5'), NOW + 5 * MINUTE_MS)
    assert.strictEqual(at('in 2 days at 9am'), utc(18, 9))
    assert.strictEqual(at('in 2 months'), Date.UTC(2027, 0, 16, 10, 0))
  })
  it('reads days and parts of the day', () => {
    assert.strictEqual(at('tonight'), utc(16, 20))
    assert.strictEqual(at('this evening'), utc(16, 18))
    assert.strictEqual(at('tomorrow morning'), utc(17, 9))
    assert.strictEqual(at('tmrw at 3'), utc(17, 15))
    assert.strictEqual(at('in the afternoon'), utc(16, 14))
    assert.strictEqual(at('by eod'), utc(16, 17))
    assert.strictEqual(at('first thing tomorrow'), utc(17, 9))
    assert.strictEqual(at('the day after tomorrow at noon'), utc(18, 12))
    assert.strictEqual(at('friday'), utc(20, 9))
    assert.strictEqual(at('next monday'), utc(23, 9))
    assert.strictEqual(at('next week'), utc(23, 9))
    assert.strictEqual(at('next month'), utc(1, 9, 0, 12))
    assert.strictEqual(at('this weekend'), utc(21, 9))
    assert.strictEqual(at('on monday morning'), utc(23, 9))
  })
  it('reads clocks with hints', () => {
    assert.strictEqual(at('at 3.30pm'), utc(16, 15, 30))
    assert.strictEqual(at('at 8 tonight'), utc(16, 20))
    assert.strictEqual(at('at 7 in the evening'), utc(16, 19))
    assert.strictEqual(at('at 9 in the morning'), utc(17, 9))
    assert.strictEqual(at('at 2 at night'), utc(17, 2))
    assert.strictEqual(at('at 07:00'), utc(17, 7))
    assert.strictEqual(at('at 11pm today'), utc(16, 23))
  })
  it('reads dates', () => {
    assert.strictEqual(at('on dec 1'), utc(1, 9, 0, 12))
    assert.strictEqual(at('1 dec at 5pm'), utc(1, 17, 0, 12))
    assert.strictEqual(at('the 5th of december'), utc(5, 9, 0, 12))
    assert.strictEqual(at('on the 1st'), utc(1, 9, 0, 12))
    assert.strictEqual(at('at 3pm on the 20th'), utc(20, 15))
    assert.strictEqual(at('2026-12-01'), utc(1, 9, 0, 12))
    assert.strictEqual(at('feb 30'), undefined)
  })
  it('reads repeats', () => {
    const repeat = (text: string) => parseWhen(text, 'UTC', NOW)?.repeat
    assert.deepStrictEqual(repeat('every morning'), { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 })
    assert.deepStrictEqual(repeat('daily at 9'), { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 })
    assert.deepStrictEqual(repeat('on mondays at 10'), { kind: 'weekly', days: [1], hour: 10, minute: 0 })
    assert.deepStrictEqual(repeat('every week on friday'), { kind: 'weekly', days: [5], hour: 9, minute: 0 })
    assert.deepStrictEqual(repeat('hourly'), { kind: 'interval', everyMs: HOUR_MS })
    assert.deepStrictEqual(repeat('every other day at 8am'), { kind: 'interval', everyMs: 2 * DAY_MS })
    assert.strictEqual(at('every other day at 8am'), utc(17, 8))
    assert.deepStrictEqual(repeat('on the 1st every month'), { kind: 'monthly', day: 1, hour: 9, minute: 0 })
    assert.deepStrictEqual(repeat('every month on the 31st at 5pm'), { kind: 'monthly', day: 31, hour: 17, minute: 0 })
  })
  it('takes a default clock for bare days', () => {
    assert.strictEqual(parseWhen('tomorrow', 'UTC', NOW, { defaultClock: { hour: 23, minute: 59 } })?.at, utc(17, 23, 59))
  })
  it('rejects nonsense', () => {
    for (const text of ['3', 'today', 'sometime', 'in 5 eons', 'every 2 hours at 3pm', 'tomorrow in 2 hours']) assert.strictEqual(at(text), undefined, text)
  })
})

describe('findWhen', () => {
  const find = (text: string) => {
    const found = findWhen(text, 'UTC', NOW)
    return found && [found.phrase, found.rest, found.when.at]
  }
  it('finds the time at either end', () => {
    assert.deepStrictEqual(find('tonight that I owe vikraman £12.08'), ['tonight', 'that I owe vikraman £12.08', utc(16, 20)])
    assert.deepStrictEqual(find('at 11pm I owe vikraman £12.08'), ['at 11pm', 'I owe vikraman £12.08', utc(16, 23)])
    assert.deepStrictEqual(find('to call mom in 10 minutes.'), ['in 10 minutes', 'to call mom', NOW + 10 * MINUTE_MS])
    assert.deepStrictEqual(find('tomorrow call bob at 3'), ['tomorrow at 3', 'call bob', utc(17, 15)])
  })
  it('leaves time-ish words in the message alone', () => {
    for (const text of ['to say good morning', 'to go out in the sun', 'to tell bob where I sat', 'to pay bob 12.50', 'to read chapter 3']) {
      assert.strictEqual(find(text), undefined, text)
    }
    assert.deepStrictEqual(find('in 5 eons to stretch'), undefined)
    assert.deepStrictEqual(find('to do x in 5'), ['in 5', 'to do x', NOW + 5 * MINUTE_MS])
    assert.deepStrictEqual(find('in 5: stretch'), ['in 5', ': stretch', NOW + 5 * MINUTE_MS])
    assert.deepStrictEqual(find('in 5 regarding the call'), ['in 5', 'regarding the call', NOW + 5 * MINUTE_MS])
  })
})

describe('parseDuration', () => {
  it('reads durations', () => {
    assert.strictEqual(parseDuration('30m'), 30 * MINUTE_MS)
    assert.strictEqual(parseDuration('1h 30m'), 90 * MINUTE_MS)
    assert.strictEqual(parseDuration('half a day'), 12 * HOUR_MS)
    assert.strictEqual(parseDuration('5', 'minutes'), 5 * MINUTE_MS)
    assert.strictEqual(parseDuration('5'), undefined)
    assert.strictEqual(parseDuration('2 months'), undefined)
  })
})
