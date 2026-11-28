// timezone-aware parsing of "when" phrases, no deps

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export const DEFAULT_TZ = 'Europe/London'

export const isValidTz = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// canonical spelling, e.g. europe/london -> Europe/London; keeps modern names icu calls legacy (asia/kolkata)
export const canonicalTz = (tz: string): string | undefined => {
  if (!isValidTz(tz)) return undefined
  const lower = tz.toLowerCase()
  const listed = Intl.supportedValuesOf('timeZone').find(name => name.toLowerCase() === lower)
  if (listed) return listed
  const resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
  if (resolved.toLowerCase() === lower) return resolved
  return tz.replace(/(^|[/_-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase())
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  // 0 = sunday
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export const zonedParts = (ms: number, tz: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short'
  }).formatToParts(new Date(ms))
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0
  }
}

// wall-clock time in tz -> epoch ms; month 1-based, day may overflow
export const fromZoned = (year: number, month: number, day: number, hour: number, minute: number, tz: string): number => {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let ms = guess
  // two passes settle dst edges
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(ms, tz)
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    ms += guess - shown
  }
  return ms
}

// yyyy-mm-dd in tz
export const dayKey = (ms: number, tz: string): string => {
  const p = zonedParts(ms, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

// the week's monday as yyyy-mm-dd in tz
export const weekKey = (ms: number, tz: string): string => {
  const p = zonedParts(ms, tz)
  return dayKey(fromZoned(p.year, p.month, p.day - (p.weekday + 6) % 7, 12, 0, tz), tz)
}

const DAY_NAMES =['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

export const weekdayOf = (word: string): number | undefined => {
  const w = word.toLowerCase()
  if (w.length < 3) return undefined
  const i = DAY_NAMES.findIndex(d => d.startsWith(w) || `${d}s` === w)
  return i === -1 ? undefined : i
}

export const formatClock = (hour: number, minute: number): string => {
  const h = hour % 12 || 12
  return `${h}${minute ? `:${String(minute).padStart(2, '0')}` : ''}${hour < 12 ? 'am' : 'pm'}`
}

export const formatWhen = (ms: number, tz: string, now = Date.now()): string => {
  const p = zonedParts(ms, tz)
  const clock = formatClock(p.hour, p.minute)
  const today = dayKey(now, tz)
  const key = dayKey(ms, tz)
  if (key === today) return `today at ${clock}`
  if (key === dayKey(now + DAY_MS, tz)) return `tomorrow at ${clock}`
  const label = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ms))
  return `${label} at ${clock}`
}

export interface Clock {
  hour: number
  minute: number
}

export type Repeat =
  | { kind: 'interval', everyMs: number }
  // days: weekdays it runs on, 0 = sunday
  | { kind: 'weekly', days: number[], hour: number, minute: number }
  // day of month, clamped to short months
  | { kind: 'monthly', day: number, hour: number, minute: number }

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MINUTE_MS, min: MINUTE_MS, mins: MINUTE_MS, minute: MINUTE_MS, minutes: MINUTE_MS,
  h: HOUR_MS, hr: HOUR_MS, hrs: HOUR_MS, hour: HOUR_MS, hours: HOUR_MS,
  d: DAY_MS, day: DAY_MS, days: DAY_MS,
  w: 7 * DAY_MS, week: 7 * DAY_MS, weeks: 7 * DAY_MS
}

export const unitMs = (unit: string): number | undefined => UNIT_MS[unit.toLowerCase()]

// "3pm", "15:30", "9:05am", "noon", "midnight"
export const parseClock = (text: string): Clock | undefined => {
  const t = text.trim().toLowerCase()
  if (t === 'noon') return { hour: 12, minute: 0 }
  if (t === 'midnight') return { hour: 0, minute: 0 }
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) return undefined
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3]
  if (minute > 59) return undefined
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  } else if (hour > 23) {
    return undefined
  }
  return { hour, minute }
}

// next weekly occurrence strictly after `after`
export const nextWeekly = (days: number[], hour: number, minute: number, tz: string, after: number): number => {
  const p = zonedParts(after, tz)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = fromZoned(p.year, p.month, p.day + offset, hour, minute, tz)
    if (candidate <= after) continue
    if (days.includes(zonedParts(candidate, tz).weekday)) return candidate
  }
  // unreachable with a non-empty days list
  return after + 7 * DAY_MS
}

// month 1-based, may overflow
export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

// next monthly occurrence strictly after `after`
export const nextMonthly = (day: number, hour: number, minute: number, tz: string, after: number): number => {
  const p = zonedParts(after, tz)
  for (let offset = 0; offset <= 12; offset++) {
    const candidate = fromZoned(p.year, p.month + offset, Math.min(day, daysInMonth(p.year, p.month + offset)), hour, minute, tz)
    if (candidate > after) return candidate
  }
  return after + 31 * DAY_MS
}

export const nextOccurrence = (repeat: Repeat, tz: string, after: number): number => {
  if (repeat.kind === 'interval') return after + repeat.everyMs
  if (repeat.kind === 'monthly') return nextMonthly(repeat.day, repeat.hour, repeat.minute, tz, after)
  return nextWeekly(repeat.days, repeat.hour, repeat.minute, tz, after)
}

export const ordinal = (n: number): string => {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
  return `${n}${suffix}`
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
export const WORKDAYS = [1, 2, 3, 4, 5]

// "day", "weekday", "weekend", "monday", "mon, wed and fri"
export const parseDays = (text: string): number[] | undefined => {
  const t = text.trim().toLowerCase()
  if (t === 'day' || t === 'daily') return ALL_DAYS
  if (t === 'weekday' || t === 'weekdays' || t === 'workday' || t === 'workdays') return WORKDAYS
  if (t === 'weekend' || t === 'weekends') return [0, 6]
  const words = t.split(/\s*(?:,|\band\b|\/)\s*|\s+/).filter(Boolean)
  const days = words.map(weekdayOf)
  if (days.length === 0 || days.some(d => d === undefined)) return undefined
  return [...new Set(days as number[])].sort()
}

export const describeRepeat = (repeat: Repeat): string => {
  if (repeat.kind === 'interval') {
    const [unit, size] = ([['week', 7 * DAY_MS], ['day', DAY_MS], ['hour', HOUR_MS], ['minute', MINUTE_MS]] as const)
      .find(([, s]) => repeat.everyMs % s === 0) ?? ['second', 1000]
    const n = repeat.everyMs / size
    return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`
  }
  const clock = formatClock(repeat.hour, repeat.minute)
  if (repeat.kind === 'monthly') return `every month on the ${ordinal(repeat.day)} at ${clock}`
  const key = repeat.days.join()
  if (key === ALL_DAYS.join()) return `every day at ${clock}`
  if (key === WORKDAYS.join()) return `every weekday at ${clock}`
  if (key === '0,6') return `every weekend at ${clock}`
  const names = repeat.days.map(d => DAY_NAMES[d]!.replace(/^./, c => c.toUpperCase()))
  return `every ${names.join(', ')} at ${clock}`
}

export interface When {
  at: number
  repeat?: Repeat
}

// MIN_INTERVAL guards against "every 1 second" spam
export const MIN_INTERVAL_MS = 5 * MINUTE_MS
// further out than this is a typo, and breaks date formatting past year 275760
export const MAX_AHEAD_MS = 2 * 365 * DAY_MS
