// natural-language times: parse a whole phrase, or find one at either end of a sentence

import * as T from './time.ts'
import type { Clock, Repeat, When } from './time.ts'

export interface WhenOptions {
  // clock for a bare day, e.g. "tomorrow"
  defaultClock?: Clock
}

const MORNING = { hour: 9, minute: 0 }
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const PARTS_OF_DAY: Record<string, Clock> = {
  morning: MORNING, afternoon: { hour: 14, minute: 0 }, evening: { hour: 18, minute: 0 }, night: { hour: 21, minute: 0 },
  lunch: { hour: 12, minute: 0 }, lunchtime: { hour: 12, minute: 0 }
}
const EOD = { hour: 17, minute: 0 }
const TONIGHT = { hour: 20, minute: 0 }
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, ninety: 90
}
const AMBIGUOUS_DAYS = new Set(['sun', 'sat', 'wed', 'mon'])
const CONNECTORS = new Set(['to', 'that', 'of', 'about', 'for', 're', 'regarding', ':', '-', '–', '—'])
const TOMORROW = new Set(['tomorrow', 'tmrw', 'tmr', 'tmw', 'tomorow', 'tommorow', 'tommorrow', '2moro'])

export interface Token {
  word: string
  start: number
  end: number
}

// lowercased words with offsets; "10min" -> 10 min, "3:30pm" -> 3:30 pm, "1h30m" -> 1 h 30 m
export const tokenize = (text: string): Token[] => {
  const tokens: Token[] = []
  for (const m of text.matchAll(/[^\s,]+/g)) {
    const raw = m[0]
    const lead = raw.match(/^[("']*/)![0].length
    const word = raw.slice(lead).replace(/[.!?;:)"']+$/, '').toLowerCase()
    const start = m.index + lead
    const colon = raw.endsWith(':') ? [{ word: ':', start: m.index + raw.length - 1, end: m.index + raw.length }] : []
    if (!word) {
      tokens.push(...colon)
      continue
    }
    if (/^(?:\d+(?:[:.]\d{2})?[a-z]+)+$/.test(word) && !/^\d+(?:st|nd|rd|th)$/.test(word)) {
      for (const piece of word.matchAll(/\d+(?:[:.]\d{2})?|[a-z]+/g)) {
        tokens.push({ word: piece[0], start: start + piece.index, end: start + piece.index + piece[0].length })
      }
    } else {
      tokens.push({ word, start, end: start + word.length })
    }
    // "in 5: stretch" splits there
    tokens.push(...colon)
  }
  return tokens
}

type DaySpec =
  | { kind: 'offset', days: number }
  | { kind: 'weekday', day: number, next: boolean }
  | { kind: 'date', year?: number, month: number, day: number }
  | { kind: 'monthday', day: number }

type Every =
  | { kind: 'interval', ms: number }
  // days unset: the weekday it starts on
  | { kind: 'weekly', days?: number[] }
  | { kind: 'monthly' }

interface Parts {
  rel?: number
  months?: number
  startOfMonth?: boolean
  day?: DaySpec
  clock?: Clock
  // am/pm or 24h spelling given
  explicit?: boolean
  // a bare number, no "at" or am/pm
  bare?: boolean
  tod?: Clock
  every?: Every
}

// a component reads tokens at i into p, returning how many it used
type Component = (t: string[], i: number, p: Parts) => number

interface Num { n: number, used: number }

const number = (t: string[], i: number): Num | undefined => {
  const w = t[i]
  if (w === undefined) return undefined
  if (/^\d+(?:\.\d+)?$/.test(w)) return { n: Number(w), used: 1 }
  if ((w === 'a' || w === 'couple') && t[i + (w === 'a' ? 1 : 0)] === 'couple') {
    const used = w === 'a' ? 2 : 1
    return { n: 2, used: t[i + used] === 'of' ? used + 1 : used }
  }
  if (w === 'a' && t[i + 1] === 'few') return { n: 3, used: 2 }
  const n = NUMBER_WORDS[w]
  return n === undefined ? undefined : { n, used: 1 }
}

interface Span { ms: number, months: number }

const unitOf = (w: string | undefined): Span | undefined => {
  if (w === undefined) return undefined
  if (/^(?:months?|mo|mos)$/.test(w)) return { ms: 0, months: 1 }
  if (/^(?:years?|yrs?)$/.test(w)) return { ms: 0, months: 12 }
  if (w === 'fortnight' || w === 'fortnights') return { ms: 14 * T.DAY_MS, months: 0 }
  const ms = T.unitMs(w)
  return ms === undefined ? undefined : { ms, months: 0 }
}

// "2 hours", "1.5h", "half an hour", "an hour and a half", "1h 30m", "2 hours and 15 minutes"
const duration = (t: string[], i: number): (Span & { used: number }) | undefined => {
  let j = i
  let total: Span | undefined
  for (;;) {
    let k = j
    if (total && t[k] === 'and') k++
    let n: number | undefined
    if (t[k] === 'half') {
      k += t[k + 1] === 'a' || t[k + 1] === 'an' ? 2 : 1
      n = 0.5
    } else {
      const num = number(t, k)
      if (!num) break
      n = num.n
      k += num.used
      if (t[k] === 'and' && t[k + 1] === 'a' && t[k + 2] === 'half') {
        n += 0.5
        k += 3
      }
    }
    const unit = unitOf(t[k])
    if (!unit) break
    k++
    if (t[k] === 'and' && t[k + 1] === 'a' && t[k + 2] === 'half') {
      n += 0.5
      k += 3
    }
    total = { ms: (total?.ms ?? 0) + n * unit.ms, months: (total?.months ?? 0) + n * unit.months }
    j = k
  }
  if (!total || !Number.isInteger(total.months)) return undefined
  return { ...total, used: j - i }
}

// "in 2 hours", "after 10 minutes", "2 hours from now", "in 5" (minutes)
const relative: Component = (t, i, p) => {
  if (p.rel !== undefined || p.months !== undefined) return 0
  const lead = t[i] === 'in' || t[i] === 'after' || t[i] === 'within'
  const d = duration(t, lead ? i + 1 : i)
  if (d) {
    let used = d.used + (lead ? 1 : 0)
    const tail = t.slice(i + used, i + used + 2).join(' ')
    if (tail === 'from now') used += 2
    else if (t[i + used] === 'later' || t[i + used] === 'time' || t[i + used] === "time's") used += 1
    else if (!lead) return 0
    p.rel = d.ms
    if (d.months) p.months = d.months
    return used
  }
  if (t[i] === 'in' && /^\d+$/.test(t[i + 1] ?? '')) {
    p.rel = Number(t[i + 1]) * T.MINUTE_MS
    return 2
  }
  return 0
}

// longest run of tokens parseDays accepts
const dayList = (t: string[], i: number): { days: number[], used: number } | undefined => {
  for (let j = Math.min(t.length, i + 7); j > i; j--) {
    const days = T.parseDays(t.slice(i, j).join(' '))
    if (days) return { days, used: j - i }
  }
  return undefined
}

const isPluralDays = (w: string | undefined): boolean =>
  w !== undefined && (/^(?:weekdays|weekends|workdays)$/.test(w) || (/s$/.test(w) && T.weekdayOf(w.slice(0, -1)) !== undefined && w.length > 4))

// "every 2 hours", "every weekday", "every other day", "every morning", "daily", "on mondays", "monthly"
const every: Component = (t, i, p) => {
  if (p.every) return 0
  const w = t[i]
  const single: Record<string, Every> = {
    daily: { kind: 'weekly', days: T.ALL_DAYS }, nightly: { kind: 'weekly', days: T.ALL_DAYS },
    hourly: { kind: 'interval', ms: T.HOUR_MS }, weekly: { kind: 'weekly' }, monthly: { kind: 'monthly' },
    fortnightly: { kind: 'interval', ms: 14 * T.DAY_MS }
  }
  if (w && single[w]) {
    p.every = single[w]
    if (w === 'nightly' && !p.tod) p.tod = PARTS_OF_DAY.night
    return 1
  }
  const on = w === 'on' ? 1 : 0
  if (isPluralDays(t[i + on])) {
    const list = dayList(t, i + on)
    if (!list) return 0
    p.every = { kind: 'weekly', days: list.days }
    return on + list.used
  }
  if (w !== 'every' && w !== 'each') return 0
  if (t[i + 1] === 'other') {
    const unit = unitOf(t[i + 2])
    if (!unit || unit.months) return 0
    p.every = { kind: 'interval', ms: 2 * unit.ms }
    return 3
  }
  const tod = PARTS_OF_DAY[t[i + 1] ?? '']
  if (tod) {
    p.every = { kind: 'weekly', days: T.ALL_DAYS }
    if (p.tod) return 0
    p.tod = tod
    return 2
  }
  const list = dayList(t, i + 1)
  const d = duration(t, i + 1) ?? (unitOf(t[i + 1]) ? { ...unitOf(t[i + 1])!, used: 1 } : undefined)
  if (d && (!list || d.used >= list.used)) {
    if (d.months === 1 && !d.ms) p.every = { kind: 'monthly' }
    else if (d.months) return 0
    else if (d.ms === T.DAY_MS) p.every = { kind: 'weekly', days: T.ALL_DAYS }
    else if (d.ms === 7 * T.DAY_MS) p.every = { kind: 'weekly' }
    else p.every = { kind: 'interval', ms: d.ms }
    return 1 + d.used
  }
  if (!list) return 0
  p.every = { kind: 'weekly', days: list.days }
  return 1 + list.used
}

const monthOf = (w: string | undefined): number | undefined => {
  if (!w || w.length < 3) return undefined
  const i = MONTHS.indexOf(w.slice(0, 3))
  return i === -1 || !('january february march april may june july august september october november december sept'.split(' ').some(m => m.startsWith(w))) ? undefined : i + 1
}

const dayNumber = (w: string | undefined, needOrdinal: boolean): number | undefined => {
  const m = w?.match(/^(\d{1,2})(st|nd|rd|th)?$/)
  if (!m || (needOrdinal && !m[2])) return undefined
  const n = Number(m[1])
  return n >= 1 && n <= 31 ? n : undefined
}

const yearAt = (t: string[], i: number): number | undefined => /^\d{4}$/.test(t[i] ?? '') ? Number(t[i]) : undefined

// "dec 1", "1st of december 2027", "the 5th", "2026-12-01"
const date = (t: string[], i: number): { spec: DaySpec, used: number } | undefined => {
  let j = i
  const iso = t[j]?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return { spec: { kind: 'date', year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }, used: 1 }
  const month = monthOf(t[j])
  if (month) {
    j++
    if (t[j] === 'the') j++
    const day = dayNumber(t[j], false)
    if (!day) return undefined
    j++
    const year = yearAt(t, j)
    return { spec: { kind: 'date', month, day, year }, used: j - i + (year ? 1 : 0) }
  }
  const the = t[j] === 'the'
  if (the) j++
  const day = dayNumber(t[j], false)
  if (!day) return undefined
  const ordinalDay = dayNumber(t[j], true) !== undefined
  j++
  const of = t[j] === 'of' ? 1 : 0
  const m = monthOf(t[j + of])
  // a lone "5" is not a date, "the 5th" is
  if (!m) return of || !ordinalDay ? undefined : { spec: { kind: 'monthday', day }, used: j - i }
  j += of + 1
  const year = yearAt(t, j)
  return { spec: { kind: 'date', month: m, day, year }, used: j - i + (year ? 1 : 0) }
}

// "today", "tonight", "tomorrow", "on friday", "next tuesday", "next week", "dec 1"
const day: Component = (t, i, p) => {
  if (p.day || p.startOfMonth) return 0
  const w = t[i] ?? ''
  const two = t.slice(i, i + 2).join(' ')
  if (w === 'today') { p.day = { kind: 'offset', days: 0 }; return 1 }
  if (w === 'tonight' || w === 'tonite') {
    p.day = { kind: 'offset', days: 0 }
    p.tod ??= TONIGHT
    return 1
  }
  const after = t.slice(i, i + 4).join(' ')
  if (/^(?:the )?day after (?:tomorrow|tmrw)/.test(after)) {
    p.day = { kind: 'offset', days: 2 }
    return after.startsWith('the ') ? 4 : 3
  }
  if (TOMORROW.has(w)) { p.day = { kind: 'offset', days: 1 }; return 1 }
  if (two === 'next week') { p.day = { kind: 'weekday', day: 1, next: true }; return 2 }
  if (two === 'next month') {
    p.months = 1
    p.startOfMonth = true
    return 2
  }
  const weekend = t.slice(i, i + 3).join(' ').match(/^(?:(?:this|next|on the|the) )?weekend/)
  if (weekend) {
    p.day = { kind: 'weekday', day: 6, next: weekend[0].startsWith('next') }
    return weekend[0].split(' ').length
  }
  const eow = t.slice(i, i + 4).join(' ').match(/^(?:eow|end of (?:the )?week)/)
  if (eow) {
    p.day = { kind: 'weekday', day: 5, next: false }
    p.tod ??= EOD
    return eow[0].split(' ').length
  }
  let j = i
  let next = false
  if (t[j] === 'on') j++
  else if (two === 'this coming') j += 2
  else if (t[j] === 'this' || t[j] === 'coming') j++
  else if (t[j] === 'next') { next = true; j++ }
  const wd = isPluralDays(t[j]) ? undefined : T.weekdayOf(t[j] ?? '')
  // "in the sun", "where I sat" stay in the message
  if (wd !== undefined && (j > i || !AMBIGUOUS_DAYS.has(t[j]!))) {
    p.day = { kind: 'weekday', day: wd, next }
    return j + 1 - i
  }
  if (next || j - i > 1) return 0
  const d = date(t, j)
  if (!d) return 0
  p.day = d.spec
  return j - i + d.used
}

// "this morning", "in the evening", "at night", "at lunch", "eod", "tomorrow morning"
const partOfDay: Component = (t, i, p) => {
  if (p.tod) return 0
  const three = t.slice(i, i + 4).join(' ')
  const eod = three.match(/^(?:(?:by|at) )?(?:eod|cob|end of (?:the )?day|close of business)/)
  if (eod) { p.tod = EOD; return eod[0].split(' ').length }
  if (t[i] === 'this' && PARTS_OF_DAY[t[i + 1] ?? '']) {
    if (p.day) return 0
    p.day = { kind: 'offset', days: 0 }
    p.tod = PARTS_OF_DAY[t[i + 1]!]
    return 2
  }
  const lead = three.match(/^(?:in the|at|by|first thing in the|first thing)\b ?/)?.[0] ?? ''
  const used = lead ? lead.trim().split(' ').length : 0
  if (lead.startsWith('first thing') && !PARTS_OF_DAY[t[i + used] ?? '']) { p.tod = MORNING; return used }
  const tod = PARTS_OF_DAY[t[i + used] ?? '']
  // bare "morning" only after a day, so "say good morning" stays in the message
  if (!tod || (!used && !p.day && !p.every)) return 0
  p.tod = tod
  return used + 1
}

// "at 3pm", "15:30", "9.30am", "noon", "by 5", "8 o'clock"
const clock: Component = (t, i, p) => {
  if (p.clock) return 0
  let j = i
  const marked = ['at', '@', 'by', 'around', 'before'].includes(t[j] ?? '')
  if (marked) j++
  if (t[j] === 'around' || t[j] === 'about') j++
  const w = t[j] ?? ''
  if (w === 'noon' || w === 'midday' || w === 'midnight') {
    p.clock = w === 'midnight' ? { hour: 0, minute: 0 } : { hour: 12, minute: 0 }
    p.explicit = true
    return j + 1 - i
  }
  const m = w.match(/^(\d{1,2})(?:([:.])(\d{2}))?$/)
  if (!m) return 0
  j++
  let meridiem: string | undefined
  if (/^(?:am|pm|p|a\.m|p\.m)$/.test(t[j] ?? '')) meridiem = t[j++]![0]
  else if (t[j] === "o'clock" || t[j] === 'oclock') j++
  // "£12.08" and "v1.20" stay in the message
  if (m[2] === '.' && !marked && !meridiem) return 0
  let hour = Number(m[1])
  const minute = m[3] ? Number(m[3]) : 0
  if (minute > 59) return 0
  if (meridiem) {
    if (hour < 1 || hour > 12) return 0
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0)
  } else if (hour > 23) {
    return 0
  }
  p.clock = { hour, minute }
  p.explicit = !!meridiem || hour > 12 || hour === 0 || m[1]!.startsWith('0')
  p.bare = !marked && !meridiem && !m[2]
  return j - i
}

const COMPONENTS: Component[] = [every, relative, day, partOfDay, clock]

// all tokens must be used
const parseParts = (t: string[]): Parts | undefined => {
  if (t.length === 0) return undefined
  const p: Parts = {}
  let i = 0
  while (i < t.length) {
    let used = 0
    for (const component of COMPONENTS) {
      const trial = { ...p }
      used = component(t, i, trial)
      if (used) {
        Object.assign(p, trial)
        break
      }
    }
    if (!used && t[i] === 'and' && i > 0 && i < t.length - 1) used = 1
    if (!used) return undefined
    i += used
  }
  return p
}

const finalClock = (p: Parts, opts: WhenOptions): Clock => {
  const c = p.clock
  if (!c) return p.tod ?? opts.defaultClock ?? MORNING
  if (p.explicit || c.hour >= 12) return c
  const tod = p.tod
  if (tod && tod.hour < 12) return c
  // "8 tonight", "6 in the evening"; "2 at night" stays am
  if (tod === PARTS_OF_DAY.night && c.hour < 5) return c
  if (tod) return { ...c, hour: c.hour + 12 }
  // "at 3" means 3pm; nobody books a 3am meeting by accident
  return c.hour >= 1 && c.hour <= 7 ? { ...c, hour: c.hour + 12 } : c
}

const resolve = (p: Parts, tz: string, now: number, opts: WhenOptions): When | undefined => {
  // a bare "3" is too likely to be part of the message
  if (p.bare && !p.day && !p.every && !p.tod) return undefined
  const timed = !!(p.clock || p.tod)
  const c = finalClock(p, opts)
  const n = T.zonedParts(now, tz)
  const at = (days: number, clockOf = c): number => T.fromZoned(n.year, n.month, n.day + days, clockOf.hour, clockOf.minute, tz)
  const nextClock = (): number => at(0) > now ? at(0) : at(1)

  if (p.every) {
    if (p.rel !== undefined || p.months !== undefined) return undefined
    const e = p.every
    if (e.kind === 'interval') {
      if (e.ms < T.MIN_INTERVAL_MS || e.ms > T.MAX_AHEAD_MS || p.day) return undefined
      // "every 2 days at 9am" keeps the clock
      if (timed && e.ms % T.DAY_MS !== 0) return undefined
      return { at: timed ? nextClock() : now + e.ms, repeat: { kind: 'interval', everyMs: e.ms } }
    }
    if (e.kind === 'monthly') {
      const dom = p.day?.kind === 'monthday' || (p.day?.kind === 'date' && p.day.year === undefined) ? p.day.day : p.day ? undefined : n.day
      if (dom === undefined) return undefined
      const repeat: Repeat = { kind: 'monthly', day: dom, ...c }
      return { at: T.nextOccurrence(repeat, tz, now), repeat }
    }
    if (p.day && (p.day.kind !== 'weekday' || e.days)) return undefined
    const days = e.days ?? [p.day?.kind === 'weekday' ? p.day.day : n.weekday]
    const repeat: Repeat = { kind: 'weekly', days, ...c }
    return { at: T.nextOccurrence(repeat, tz, now), repeat }
  }

  if (p.months !== undefined || p.rel !== undefined) {
    if (p.day) return undefined
    if (p.months !== undefined) {
      const month = n.month + p.months
      const dom = p.startOfMonth ? 1 : Math.min(n.day, T.daysInMonth(n.year, month))
      const clockOf = timed || p.startOfMonth ? c : { hour: n.hour, minute: n.minute }
      return { at: T.fromZoned(n.year, month, dom, clockOf.hour, clockOf.minute, tz) + (p.rel ?? 0) }
    }
    const rel = p.rel!
    if (rel <= 0) return undefined
    if (!timed) return { at: now + rel }
    // "in 2 days at 9am"
    if (rel % T.DAY_MS !== 0) return undefined
    return { at: at(rel / T.DAY_MS) }
  }

  const d = p.day
  if (!d) return { at: nextClock() }
  if (d.kind === 'offset') return { at: at(d.days) }
  if (d.kind === 'weekday') {
    let next = T.nextWeekly([d.day], c.hour, c.minute, tz, now)
    if (d.next && T.dayKey(next, tz) === T.dayKey(now, tz)) next = T.nextWeekly([d.day], c.hour, c.minute, tz, next)
    return { at: next }
  }
  if (d.kind === 'monthday') {
    for (let offset = 0; offset <= 12; offset++) {
      if (d.day > T.daysInMonth(n.year, n.month + offset)) continue
      const candidate = T.fromZoned(n.year, n.month + offset, d.day, c.hour, c.minute, tz)
      if (candidate > now) return { at: candidate }
    }
    return undefined
  }
  const year = d.year ?? n.year
  if (d.month < 1 || d.month > 12 || d.day > T.daysInMonth(year, d.month)) return undefined
  const candidate = T.fromZoned(year, d.month, d.day, c.hour, c.minute, tz)
  if (candidate > now || d.year !== undefined) return { at: candidate }
  if (d.day > T.daysInMonth(year + 1, d.month)) return undefined
  return { at: T.fromZoned(year + 1, d.month, d.day, c.hour, c.minute, tz) }
}

const inRange = (when: When | undefined, now: number): When | undefined =>
  when && when.at > now && when.at - now <= T.MAX_AHEAD_MS ? when : undefined

const parseTokens = (t: string[], tz: string, now: number, opts: WhenOptions): When | undefined => {
  const p = parseParts(t)
  return p ? inRange(resolve(p, tz, now, opts), now) : undefined
}

// "in 5 minutes", "tonight", "tomorrow morning", "next friday at 3", "every weekday at 9am", "on the 1st every month"
export const parseWhen = (text: string, tz: string, now = Date.now(), opts: WhenOptions = {}): When | undefined =>
  parseTokens(tokenize(text).map(t => t.word), tz, now, opts)

export interface Found {
  when: When
  // the time phrase(s) as written
  phrase: string
  // the text around it
  rest: string
}

// a time phrase at the start, the end, or both: "tonight that I owe bob £5", "call mom at 3pm", "tomorrow call bob at 3"
export const findWhen = (text: string, tz: string, now = Date.now(), opts: WhenOptions = {}): Found | undefined => {
  const tokens = tokenize(text)
  const words = tokens.map(t => t.word)
  const n = words.length
  // "in 5 eons to stretch" is not 5 minutes
  const bareEnd = (len: number): boolean =>
    words[len - 2] === 'in' && /^\d+$/.test(words[len - 1]!) && len < n && !CONNECTORS.has(words[len]!)
  const longest = (fromStart: boolean): number => {
    for (let len = n; len > 0; len--) {
      if (fromStart && bareEnd(len)) continue
      if (parseTokens(fromStart ? words.slice(0, len) : words.slice(n - len), tz, now, opts)) return len
    }
    return 0
  }
  const pre = longest(true)
  if (pre === n) return { when: parseTokens(words, tz, now, opts)!, phrase: text.trim(), rest: '' }
  const suf = longest(false)
  const slice = (a: number, b: number): string => a < b ? text.slice(tokens[a]!.start, tokens[b - 1]!.end) : ''
  // fall back to the end of the raw word so trailing punctuation stays in the message
  const restOf = (a: number, b: number): string => a < b ? text.slice(tokens[a]!.start, b < n ? tokens[b]!.start : text.length).trim() : ''
  if (pre && suf && pre + suf < n) {
    const when = parseTokens([...words.slice(0, pre), ...words.slice(n - suf)], tz, now, opts)
    if (when) return { when, phrase: `${slice(0, pre)} ${slice(n - suf, n)}`, rest: text.slice(tokens[pre]!.start, tokens[n - suf]!.start).trim() }
  }
  if (!pre && !suf) return undefined
  if (pre >= suf) return { when: parseTokens(words.slice(0, pre), tz, now, opts)!, phrase: slice(0, pre), rest: restOf(pre, n) }
  return { when: parseTokens(words.slice(n - suf), tz, now, opts)!, phrase: slice(n - suf, n), rest: text.slice(0, tokens[n - suf]!.start).trim() }
}

// "30m", "1h30m", "1.5 hours", "half an hour"; a bare number uses defaultUnit
export const parseDuration = (text: string, defaultUnit?: string): number | undefined => {
  const words = tokenize(text).map(t => t.word)
  if (defaultUnit && words.length === 1 && /^\d+$/.test(words[0]!)) {
    const size = T.unitMs(defaultUnit)
    return size === undefined ? undefined : Number(words[0]) * size
  }
  const d = duration(words, 0)
  return d && d.used === words.length && !d.months ? d.ms : undefined
}
